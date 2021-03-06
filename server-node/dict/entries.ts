import { elapsed, now } from '../../lib-ts'

import { SearchCache } from './cache'
import DB from './db'
import { Entry } from './entry'
import * as query from './query'

export async function entries_exact(words: string[]) {
	return await Entry.exact(words)
}

export async function word_count() {
	return await Entry.count()
}

export async function words(args: { offset?: number; limit?: number }) {
	const offset = Math.max(0, Math.round(args.offset || 0))
	const limit = Math.max(0, Math.round(args.limit || 100))
	const dict = await DB.get_dict()

	// Adding position to this query forces SQLite to use a table scan instead
	// of a index scan, preserving the natural order of the table without using
	// an ORDER BY (which would cause a full table scan).
	const rows = await dict.query<{ sequence: string }>(
		`SELECT sequence, position FROM entries LIMIT ${limit} OFFSET ${offset}`,
	)
	const ids = rows.map((x) => x.sequence)
	const entries = await Entry.get(ids)
	return entries
}

export async function by_id(args: { id: string }) {
	return (await Entry.get([args.id])).shift()
}

export async function by_ids(args: { ids: string[] }) {
	return await Entry.get(args.ids)
}

export async function lookup({ kanji, reading }: { kanji: string; reading: string }) {
	const has_kanji = kanji && kanji != reading
	const kanji_where = has_kanji ? '= ?' : 'IS NULL'
	const args = has_kanji ? [kanji, reading] : [reading]
	const dict = await DB.get_dict()
	const rows = await dict.query<{ sequence: string }>(
		`
		SELECT DISTINCT e.sequence FROM entries e
		LEFT JOIN entries_kanji k ON e.sequence = k.sequence
		LEFT JOIN entries_reading r ON e.sequence = r.sequence
		WHERE k.expr ${kanji_where} AND r.expr = ?
	`,
		args,
	)
	const ids = rows.map((x) => x.sequence)
	const entries = await Entry.get(ids)
	if (entries.length > 1) {
		return entries.filter((x) => {
			if (has_kanji && (!x.kanji.length || x.kanji[0].expr != kanji)) {
				return false
			}
			if (x.reading[0].expr != reading) {
				return false
			}
			return true
		})
	}
	return entries
}

//============================================================================//
// Search
//============================================================================//

/**
 * Advanced search for entries. For details on the syntax and behavior see
 * the GraphQL documentation in `graph.ts`.
 */
export async function search(args: { id: string; query: string }) {
	const parsed = query.parse(args.query)

	// Get a cached search instance if any. This will create a new instance if
	// none is available.
	const cache = SearchCache.get(parsed.id)

	// The first time 'search' is called (or if a previous instance has been
	// purged from the cache) this will run to execute the search.
	parsed &&
		cache &&
		cache.start_if(async () => {
			const db = await DB.get_dict()
			const start = now()

			let count = 0

			// TODO: implement negative terms

			// We search each predicate in turn.
			for (let i = 0; i < parsed.predicates.length; i++) {
				// For the last predicate we return extended results
				const extended = i == parsed.predicates.length - 1
				const predicate = parsed.predicates[i]

				let cur_count = 0
				cur_count += await query.search_exact(cache, db, predicate)

				if (extended || cur_count == 0) {
					const allow_partial = extended && cur_count == 0
					cur_count += await query.search_deinflection(
						cache,
						db,
						predicate,
						allow_partial,
						// hard limit the maximum number of deinflected matches on entries that have results
						cur_count > 0 ? 10 : 0,
					)
				}

				// Limit applied to partial searches like prefix, suffix, and
				// contains.
				//
				// We limit all but the last predicate to keep the results of
				// multiple-term queries more manageable.
				const limit = extended ? 0 : 10

				if (cur_count == 0 || extended) {
					cur_count += await query.search_with_mode('prefix', 'exact', cache, db, predicate, limit)
					cur_count += await query.search_with_mode('suffix', 'exact', cache, db, predicate, limit)
				}

				// Search an entire phrase
				if (cur_count == 0) {
					const allow_partial = extended
					cur_count += await query.search_phrase(cache, db, predicate, allow_partial)
				}

				// The contains search is very slow, so we limit this the last
				// term and only if no other results were found.
				if (cur_count == 0 || extended) {
					cur_count += await query.search_with_mode('contains', 'exact', cache, db, predicate, limit)
				}

				// If no results were found, try the approximate search. Also if
				// explicitly requested.
				const is_approximate = predicate.type == 'query' && predicate.mode == 'approximate'

				// We also return approximate results for the last predicate
				// regardless.
				if (cur_count == 0 || extended || is_approximate) {
					cur_count += await query.search_with_mode('full', 'approx', cache, db, predicate, limit)
				}

				if (cur_count == 0 && (extended || is_approximate)) {
					cur_count += await query.search_with_mode('prefix', 'approx', cache, db, predicate, limit)
				}

				if (cur_count == 0 && (extended || is_approximate)) {
					cur_count += await query.search_with_mode('suffix', 'approx', cache, db, predicate, limit)
				}

				if (cur_count == 0 && (extended || is_approximate)) {
					cur_count += await query.search_with_mode('contains', 'approx', cache, db, predicate, limit)
				}

				// Fuzzy queries are only done if explicitly requested.
				if (predicate.type == 'query' && predicate.mode == 'fuzzy') {
					cur_count += await query.search_with_mode('full', 'fuzzy', cache, db, predicate, limit)
					cur_count += await query.search_with_mode('prefix', 'fuzzy', cache, db, predicate, limit)
					cur_count += await query.search_with_mode('suffix', 'fuzzy', cache, db, predicate, limit)
					cur_count += await query.search_with_mode('contains', 'fuzzy', cache, db, predicate, limit)
				}

				count += cur_count
			}

			cache.log(`search completed in ${elapsed(start)}`)
			cache.log(`found ${cache.count} unique entries from ${count} rows`)
		})

	// This is used to synchronize the information fields for search results so
	// we'll wait for after the pages have been loaded to get the information.
	const pages: Promise<unknown>[] = []
	const sync = new Promise<void>((resolve) => {
		// Wait for the next tick and resolve to a new promise that will wait
		// on all pages. This relies on the GraphQL library calling all `page`
		// fields synchronously as soon as the `search` function returns.
		process.nextTick(() =>
			resolve(
				Promise.all(pages).then(() => {
					return
				}),
			),
		)
	})

	cache && process.nextTick(() => cache.solve_completed())

	return {
		id: args.id || args.query,

		// Informational fields will wait on all pages to provide the most
		// up-to-date result at the time the search returns.
		async total() {
			await sync
			return cache ? cache.count : 0
		},
		async elapsed() {
			await sync
			return cache ? cache.elapsed : 0
		},
		async loading() {
			await sync
			return cache ? cache.loading : false
		},

		// Retrieves a page from the results.
		page({ offset, limit }: { offset?: number; limit?: number } = {}) {
			if (offset == null || offset < 0) {
				throw new Error(`invalid offset (${offset})`)
			}
			if (limit == null || limit < 0) {
				throw new Error(`invalid limit (${limit})`)
			}

			const load = (async () => {
				const entries = cache ? await cache.page(offset, limit) : []
				return {
					offset,
					limit,
					entries,
				}
			})()

			pages.push(load)
			return load
		},
	}
}
