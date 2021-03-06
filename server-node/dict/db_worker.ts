import * as path from 'path'
import { parentPort, workerData } from 'worker_threads'

import sqlite from 'better-sqlite3'

const DEBUG = false

const DATA_DIR = path.join('.', 'data')

const dbs = new Map<string, sqlite.Database>()

/**
 * Any databases that we want preloaded by all workers.
 */
const PRELOAD: string[] = ['dict.db']

const { id } = workerData as { id: string }

DEBUG && console.log(`DB worker ${id}: started`)

function get_db(file: string) {
	const db =
		dbs.get(file) ||
		(() => {
			const db_path = path.join(DATA_DIR, file)
			const db = new sqlite(db_path, { readonly: true, fileMustExist: true })
			dbs.set(file, db)
			DEBUG && console.log(`DB worker ${id}: opened ${file}`)
			return db
		})()
	return db
}

PRELOAD.forEach((it) => get_db(it))

parentPort!.on(
	'message',
	({
		file,
		sql,
		params,
		incremental,
	}: {
		id: number
		file: string
		sql: string
		params?: unknown
		incremental?: boolean
	}) => {
		try {
			const db = get_db(file)
			const stmt = db.prepare(sql)
			if (params) {
				stmt.bind(params)
			}
			if (incremental) {
				for (const row of stmt.iterate()) {
					parentPort!.postMessage(row)
				}
				parentPort!.postMessage('done')
			} else {
				const rows = stmt.all()
				parentPort!.postMessage(rows)
			}
		} catch (e) {
			const err = e as Error
			parentPort!.postMessage({
				error: `${err}${err.stack ? ' \n-- Stack: ' + err.stack + '\n--' : ''}`,
			})
		}
	},
)
