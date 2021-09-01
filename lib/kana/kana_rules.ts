import { is_kana } from './chars'
import { convert_next, filter_output, m, mFn, RuleContext, rules, RuleSet, transform_rules } from './conversion'
import { tuple } from './util'
import { to_voiced } from './voiced'

// TODO: halfwidth katakana filter

/** Main rule set to convert from any input to katakana. */
export function rules_to_katakana() {
	return rules(
		set_hiragana_to_katakana(),
		set_romaji_to_katakana(),
		set_romaji_double_vowels_as_prolonged_sound_mark(),
	)
}

/** Main rule set to convert from any input to hiragana. */
export function rules_to_hiragana() {
	return rules(set_katakana_to_hiragana(), set_romaji_to_hiragana())
}

/** Rules to convert just the fullwidth characters to ASCII. */
export function rules_fullwidth_to_ascii() {
	return rules(
		set_punctuation_to_romaji(),
		...map_romaji_fullwidth_ascii((h: string, k: string, r: string) => m(h, r)),
	)
}

/** Rules to convert just ASCII letters to fullwidth. */
export function rules_ascii_to_fullwidth() {
	const mapper = (h: string, k: string, r: string) => m(r, h)
	return rules(...map_romaji_fullwidth_ascii(mapper))
}

/** Main rule set to convert kana to romaji. */
export function rules_to_romaji() {
	const baseOutput = rules(
		set_kana_to_romaji(false),
		set_kana_to_romaji(true),
		set_punctuation_to_romaji(),

		// Weird and rare characters
		m('ゟ', 'yori'),
		m('ヿ', 'KOTO'),

		// Small tsu rule
		mFn('っ', (ctx) => small_tsu(ctx, true)),
		mFn('ッ', (ctx) => small_tsu(ctx, false)),
	)

	function small_tsu(ctx: RuleContext, hiragana: boolean) {
		// Count the number of small tsu following the current one
		const match = ctx.nextInput.match(/^[っッ]+/)
		const count = 1 + (match ? match[0].length : 0)
		const [output, length, context] = convert_next(ctx.nextInput.slice(count - 1), ctx.rules)

		// spell-checker: ignore bcdfghjklmnpqrstvwxyz
		const valid = length && /^[bcdfghjklmnpqrstvwxyz]/i.test(output)
		if (valid) {
			const prefix = output[0].repeat(count)
			return tuple(prefix + output, count + length, context.lastOutput)
		}

		if (is_kana(ctx.lastInput)) {
			const prefix = '~'.repeat(count)
			return tuple(prefix, count)
		}

		return tuple('~' + (hiragana ? 'tsu' : 'TSU') + '~'.repeat(count - 1), count)
	}

	// Add a filter that prevents ambiguous n rules to be generated by adding an
	// apostrophe to the output. For example:
	//
	//     `なんな` -> `na` + `n` + `na` -> `na` + `n` + `'na`
	//
	const output = filter_output(baseOutput, (ctx, rule, output) =>
		/^([ny]|[aeiou])/i.test(output) && /n$/i.test(ctx.lastOutput) && !/[Ａ-Ｚ]/i.test(ctx.input)
			? `'${output}`
			: output,
	)

	return output
}

//============================================================================//
// Mappers
//============================================================================//

/**
 * Maps any rules that maps an input that ends with a romaji vowel and generates
 * the variants for the long vowels. The variants have the same output, but add
 * a kana long sound mark to it.
 *
 * This only works with simple (non-function) rules.
 */
function map_rules_for_long_vowels(rules: RuleSet) {
	const I = 'aeiouAEIOU'
	const A = 'âêîôûÂÊÎÔÛ'
	const B = 'āēīōūĀĒĪŌŪ'

	const RE_VOWEL = /[aeiou]$/i

	const replace = (input: string, table: string) =>
		input.replace(RE_VOWEL, (key) => {
			const index = I.indexOf(key)
			return table[index]
		})

	return transform_rules(rules, (input) => {
		if (RE_VOWEL.test(input.key) && input.out) {
			return [
				input,
				{ isRuleSet: false, key: replace(input.key, A), out: input.out + 'ー' },
				{ isRuleSet: false, key: replace(input.key, B), out: input.out + 'ー' },
			]
		}
		return input
	})
}

//============================================================================//
// Rule sets
//============================================================================//

/** All rules to convert katakana to hiragana. */
function set_katakana_to_hiragana() {
	const ls = [
		// Basic letters
		...map_kana((h, k) => m(k, h)),
		...map_small_kana((h, k) => m(k, h)),

		// Rare and weird characters
		m('ヽ', 'ゝ'), // Iteration Mark
		m('ヾ', 'ゞ'), // Voiced Iteration Mark
		m('ヿ', 'こと'), // Digraph Koto
		m('ｰ', 'ー'), // Halfwidth Katakana-Hiragana Prolonged Sound Mark
		...map_rare_katakana((h, k) => m(k, h)),
	]
	return rules(...ls)
}

/** All rules to convert hiragana to katakana. */
function set_hiragana_to_katakana() {
	const ls = [
		// Basic letters
		...map_kana((h, k) => m(h, k)),
		...map_small_kana((h, k) => m(h, k)),

		// Missing hiragana characters

		// Rare and weird characters
		m('ゝ', 'ヽ'), // Iteration Mark
		m('ゞ', 'ヾ'), // Voiced Iteration Mark
		m('ゟ', 'ヨリ'), // Digraph Yori
	]
	return rules(...ls)
}

/** All rules to convert romaji to hiragana. */
function set_romaji_to_hiragana() {
	return set_romaji_to_kana(true)
}

/** All rules to convert romaji to katakana. */
function set_romaji_to_katakana() {
	return set_romaji_to_kana(false)
}

/** Compiles all rules from romaji to hiragana or katakana. */
function set_romaji_to_kana(hiragana: boolean, ime = true) {
	const mapper = (h: string, k: string, r: string) => (hiragana ? m(r, h) : m(r, k))
	const ls = [
		...map_kana(mapper),
		...map_digraphs(mapper), // after map_kana to override archaic characters
		...map_romaji_punctuation(mapper),
	]
	const baseOutput = rules(
		...ls,
		set_romaji_double_consonants(hiragana),
		set_romaji_quoted_long_vowels(hiragana),
		!ime
			? rules()
			: rules(
					...map_romaji_ime(mapper),
					mFn('nn', (ctx) => {
						const out = hiragana ? 'ん' : 'ン'
						// At the end of an input, we map 'nn' -> 'ん' so that
						// typing a double N with IME will generate 'ん'.
						if (!ctx.nextInput) {
							return tuple(out, 2)
						}
						// Otherwise we map 'n' -> 'ん', ignoring the 'nn'. We
						// don't want to generate a 'っ' here because that is
						// the less useful sequence.
						return tuple(out, 1)
					}),
			  ),
	)

	const vowelsOutput = map_rules_for_long_vowels(baseOutput)
	return vowelsOutput
}

/** Conversion for the double consonants using っ or ッ */
function set_romaji_double_consonants(hiragana: boolean) {
	const CONSONANTS = [
		'b',
		'c',
		'd',
		'f',
		'g',
		'h',
		'j',
		'k',
		// 'l',
		'm',
		// 'n', -- this is overridden in set_romaji_to_kana
		'p',
		'q',
		'r',
		's',
		't',
		'v',
		'w',
		// 'x',
		'y',
		'z',
	]
	const list = CONSONANTS.map((x) => m(x + x, hiragana ? 'っ' : 'ッ', 1))
	return rules(...list)
}

/** Conversion rules for sequences like "ka'a" to "かあ" or "カア" */
function set_romaji_quoted_long_vowels(hiragana: boolean) {
	// Generate the quoted sequence (e.g. `'a` => `あ` for the key `a`).
	const q = (key: string, out: string) =>
		mFn(`'${key}`, (ctx) => {
			// Only translate a sequence like `a'a`, this is to avoid messing
			// up random quoted text.
			const last = ctx.lastInput
			if (last && last[last.length - 1].toLowerCase() === key) {
				return tuple(out, 0)
			}
			return tuple('', -1)
		})
	return rules(
		// Generate a quoted rule for each of the vowels
		q('a', hiragana ? 'あ' : 'ア'),
		q('i', hiragana ? 'い' : 'イ'),
		q('u', hiragana ? 'う' : 'ウ'),
		q('e', hiragana ? 'え' : 'エ'),
		q('o', hiragana ? 'お' : 'オ'),
	)
}

/**
 * Handle romaji double vowels with a prolonged sound mark (e.g. `aa` => `アー`)
 */
function set_romaji_double_vowels_as_prolonged_sound_mark() {
	const q = (key: string, out: string) =>
		mFn(key, (ctx) => {
			const last = ctx.lastInput
			const isLongVowel = last && last[last.length - 1].toLowerCase() === key
			const sameVowelNext = ctx.nextInput.slice(0, 1).toLowerCase() === key
			return tuple(isLongVowel && !sameVowelNext ? 'ー' : out, 0)
		})
	return rules(
		// generate one rule for each vowel
		q('a', 'ア'),
		q('i', 'イ'),
		q('u', 'ウ'),
		q('e', 'エ'),
		q('o', 'オ'),
	)
}

/** Conversion rules for kana to romaji. */
function set_kana_to_romaji(hiragana: boolean) {
	const repeat_marks = (mark: string, voiced: boolean) =>
		mFn(mark, (ctx) => {
			if (is_kana(ctx.lastInput) && /^[a-z]+$/i.test(ctx.lastOutput)) {
				const last = /yori|koto|masu/i.test(ctx.lastOutput) ? ctx.lastOutput.slice(-2) : ctx.lastOutput
				return tuple(voiced ? to_voiced(last) : last, 0, last)
			}
			return tuple('', -1)
		})
	const nc_mapper = hiragana
		? (h: string, k: string, r: string) => m(h, r)
		: (h: string, k: string, r: string) => m(k, r)
	const mapper = hiragana
		? (h: string, k: string, r: string) => m(h, r.toLowerCase())
		: (h: string, k: string, r: string) => m(k, r.toUpperCase())
	const ls = [
		...map_small_kana(mapper),
		...map_kana(mapper),
		...map_digraphs(mapper),
		...map_romaji_fullwidth_ascii(nc_mapper),

		// Additional common digraph combinations for foreign syllables
		m(hiragana ? 'てぃ' : 'ティ', hiragana ? 'ti' : 'TI'),
		m(hiragana ? 'でぃ' : 'ディ', hiragana ? 'di' : 'DI'),
		m(hiragana ? 'どぅ' : 'ドゥ', hiragana ? 'du' : 'DU'),

		//
		// Rare stuff
		//

		...map_rare_katakana(mapper),
		repeat_marks(hiragana ? 'ゝ' : 'ヽ', false),
		repeat_marks(hiragana ? 'ゞ' : 'ヾ', true),
		m('〼', hiragana ? 'masu' : 'MASU'),
	]
	return rules(...ls)
}

/** Conversion rules for Japanese punctuation to romaji. */
function set_punctuation_to_romaji() {
	const mapper = (h: string, k: string, r: string) => m(h, r)
	const ls = [
		...map_extra_romaji_punctuation(mapper), // lower precedence than map_romaji_punctuation
		...map_romaji_punctuation(mapper),
	]
	return rules(...ls)
}

//============================================================================//
// Character mappings
//============================================================================//

type MapFn<T> = (hiragana: string, katakana: string, romaji: string, special?: boolean) => T

function map_small_kana<T>(m: MapFn<T>): T[] {
	return [
		m('ぁ', 'ァ', 'a', true),
		m('ぃ', 'ィ', 'i', true),
		m('ぅ', 'ゥ', 'u', true),
		m('ぇ', 'ェ', 'e', true),
		m('ぉ', 'ォ', 'o', true),
		m('っ', 'ッ', 'tsu', true),
		m('ゃ', 'ャ', 'ya', true),
		m('ゅ', 'ュ', 'yu', true),
		m('ょ', 'ョ', 'yo', true),
	]
}

/** Katakana only characters that are rarely used. */
function map_rare_katakana<T>(m: MapFn<T>): T[] {
	return [
		// Those are rarely and don't have a corresponding hiragana, so we need
		// to use the combining mark.
		m('わ\u{3099}', 'ヷ', 'va'),
		m('ゐ\u{3099}', 'ヸ', 'vi'),
		m('ゑ\u{3099}', 'ヹ', 've'),
		m('を\u{3099}', 'ヺ', 'vo'),

		// Other rare katakana
		m('え', '𛀀', 'e'),

		m('く', 'ㇰ', 'ku'), // small ku
		m('し', 'ㇱ', 'shi'), // small si
		m('す', 'ㇲ', 'su'), // small su
		m('と', 'ㇳ', 'to'), // small to
		m('ぬ', 'ㇴ', 'nu'), // small nu
		m('は', 'ㇵ', 'ha'), // small ha
		m('ひ', 'ㇶ', 'hi'), // small hi
		m('ふ', 'ㇷ', 'fu'), // small hu
		m('へ', 'ㇸ', 'he'), // small he
		m('ほ', 'ㇹ', 'ho'), // small ho
		m('む', 'ㇺ', 'mu'), // small mu
		m('ら', 'ㇻ', 'ra'), // small ra
		m('り', 'ㇼ', 'ri'), // small ri
		m('る', 'ㇽ', 'ru'), // small ru
		m('れ', 'ㇾ', 're'), // small re
		m('ろ', 'ㇿ', 'ro'), // small ro
	]
}

/** All common kana letters, except small digraph letters. */
function map_kana<T>(m: MapFn<T>): T[] {
	return [
		// Those are small but don't participate in any digraph. We need those
		// first to be overridden by later rules (e.g. for romaji)
		m('ゎ', 'ヮ', 'wa'),
		m('ゕ', 'ヵ', 'ka'),
		m('ゖ', 'ヶ', 'ka'), // transliterate to romaji as "ka" (https://en.wikipedia.org/wiki/Small_ke)

		// "N" mappings
		m('ん', 'ン', `n'`), // This first so it has lesser precedence
		m('ん', 'ン', 'n'),

		// Non-standard romaji mappings (those must come before so they are
		// overridden when mapping from kana)

		m('か', 'カ', 'ca'),
		m('し', 'シ', 'ci'),
		m('く', 'ク', 'cu'),
		m('せ', 'セ', 'ce'),
		m('こ', 'コ', 'co'),

		m('し', 'シ', 'si'),
		m('じ', 'ジ', 'zi'),

		m('ち', 'チ', 'ti'),
		m('ぢ', 'ヂ', 'dji'),
		m('ぢ', 'ヂ', 'dzi'),

		m('つ', 'ツ', 'tu'),
		m('づ', 'ヅ', 'dzu'),

		m('ふ', 'フ', 'hu'),

		m('う', 'ウ', 'wu'),

		// Normal syllables

		m('あ', 'ア', 'a'),
		m('い', 'イ', 'i'),
		m('う', 'ウ', 'u'),
		m('え', 'エ', 'e'),
		m('お', 'オ', 'o'),
		m('か', 'カ', 'ka'),
		m('き', 'キ', 'ki'),
		m('く', 'ク', 'ku'),
		m('け', 'ケ', 'ke'),
		m('こ', 'コ', 'ko'),
		m('が', 'ガ', 'ga'),
		m('ぎ', 'ギ', 'gi'),
		m('ぐ', 'グ', 'gu'),
		m('げ', 'ゲ', 'ge'),
		m('ご', 'ゴ', 'go'),
		m('さ', 'サ', 'sa'),
		m('し', 'シ', 'shi'),
		m('す', 'ス', 'su'),
		m('せ', 'セ', 'se'),
		m('そ', 'ソ', 'so'),
		m('ざ', 'ザ', 'za'),
		m('じ', 'ジ', 'ji'),
		m('ず', 'ズ', 'zu'),
		m('ぜ', 'ゼ', 'ze'),
		m('ぞ', 'ゾ', 'zo'),
		m('た', 'タ', 'ta'),
		m('ち', 'チ', 'chi'),
		m('つ', 'ツ', 'tsu'),
		m('て', 'テ', 'te'),
		m('と', 'ト', 'to'),
		m('だ', 'ダ', 'da'),
		m('ぢ', 'ヂ', 'di'),
		m('づ', 'ヅ', 'du'),
		m('で', 'デ', 'de'),
		m('ど', 'ド', 'do'),
		m('な', 'ナ', 'na'),
		m('に', 'ニ', 'ni'),
		m('ぬ', 'ヌ', 'nu'),
		m('ね', 'ネ', 'ne'),
		m('の', 'ノ', 'no'),
		m('は', 'ハ', 'ha'),
		m('ひ', 'ヒ', 'hi'),
		m('ふ', 'フ', 'fu'),
		m('へ', 'ヘ', 'he'),
		m('ほ', 'ホ', 'ho'),
		m('ば', 'バ', 'ba'),
		m('び', 'ビ', 'bi'),
		m('ぶ', 'ブ', 'bu'),
		m('べ', 'ベ', 'be'),
		m('ぼ', 'ボ', 'bo'),
		m('ぱ', 'パ', 'pa'),
		m('ぴ', 'ピ', 'pi'),
		m('ぷ', 'プ', 'pu'),
		m('ぺ', 'ペ', 'pe'),
		m('ぽ', 'ポ', 'po'),
		m('ま', 'マ', 'ma'),
		m('み', 'ミ', 'mi'),
		m('む', 'ム', 'mu'),
		m('め', 'メ', 'me'),
		m('も', 'モ', 'mo'),
		m('や', 'ヤ', 'ya'),
		m('ゆ', 'ユ', 'yu'),
		m('よ', 'ヨ', 'yo'),
		m('ら', 'ラ', 'ra'),
		m('り', 'リ', 'ri'),
		m('る', 'ル', 'ru'),
		m('れ', 'レ', 're'),
		m('ろ', 'ロ', 'ro'),
		m('わ', 'ワ', 'wa'),
		m('ゐ', 'ヰ', 'wi'),
		m('ゑ', 'ヱ', 'we'),
		m('を', 'ヲ', 'wo'),
		m('ゔ', 'ヴ', 'vu'),
	]
}

/** Map syllables made from combination of kana and small letters */
function map_digraphs<T>(m: MapFn<T>): T[] {
	return [
		// Non-default combinations first, so they are overridden when
		// generating romaji

		m('じゃ', 'ジャ', 'jya'),
		m('じゅ', 'ジュ', 'jyu'),
		m('じぇ', 'ジェ', 'jye'),
		m('じょ', 'ジョ', 'jyo'),

		m('じゃ', 'ジャ', 'zya'),
		m('じゅ', 'ジュ', 'zyu'),
		m('じぇ', 'ジェ', 'zye'),
		m('じょ', 'ジョ', 'zyo'),

		m('ちゃ', 'チャ', 'tya'),
		m('ちゅ', 'チュ', 'tyu'),
		m('ちぇ', 'チェ', 'tye'),
		m('ちょ', 'チョ', 'tyo'),

		m('ぢゃ', 'ヂャ', 'dja'),
		m('ぢゅ', 'ヂュ', 'dju'),
		m('ぢぇ', 'ヂェ', 'dje'),
		m('ぢょ', 'ヂョ', 'djo'),

		m('ぢゃ', 'ヂャ', 'dza'),
		m('ぢぇ', 'ヂェ', 'dze'),
		m('ぢょ', 'ヂョ', 'dzo'),

		m('くぁ', 'クァ', 'qwa'),
		m('くぃ', 'クィ', 'qwi'),
		m('くぇ', 'クェ', 'qwe'),
		m('くぉ', 'クォ', 'qwo'),

		// Default combinations

		m('いぇ', 'イェ', 'ye'),

		m('きゃ', 'キャ', 'kya'),
		m('きゅ', 'キュ', 'kyu'),
		m('きぇ', 'キェ', 'kye'),
		m('きょ', 'キョ', 'kyo'),

		m('ぎゃ', 'ギャ', 'gya'),
		m('ぎゅ', 'ギュ', 'gyu'),
		m('ぎぇ', 'ギェ', 'gye'),
		m('ぎょ', 'ギョ', 'gyo'),

		m('くぁ', 'クァ', 'qua'),
		m('くぃ', 'クィ', 'qui'),
		m('くぇ', 'クェ', 'que'),
		m('くぉ', 'クォ', 'quo'),

		m('しゃ', 'シャ', 'sha'),
		m('しゅ', 'シュ', 'shu'),
		m('しぇ', 'シェ', 'she'),
		m('しょ', 'ショ', 'sho'),

		m('じゃ', 'ジャ', 'ja'),
		m('じゅ', 'ジュ', 'ju'),
		m('じぇ', 'ジェ', 'je'),
		m('じょ', 'ジョ', 'jo'),

		m('ちゃ', 'チャ', 'cha'),
		m('ちゅ', 'チュ', 'chu'),
		m('ちぇ', 'チェ', 'che'),
		m('ちょ', 'チョ', 'cho'),

		m('ぢゃ', 'ヂャ', 'dya'),
		m('ぢゅ', 'ヂュ', 'dyu'),
		m('ぢぇ', 'ヂェ', 'dye'),
		m('ぢょ', 'ヂョ', 'dyo'),

		m('にゃ', 'ニャ', 'nya'),
		m('にゅ', 'ニュ', 'nyu'),
		m('にぇ', 'ニェ', 'nye'),
		m('にょ', 'ニョ', 'nyo'),

		m('ひゃ', 'ヒャ', 'hya'),
		m('ひゅ', 'ヒュ', 'hyu'),
		m('ひぇ', 'ヒェ', 'hye'),
		m('ひょ', 'ヒョ', 'hyo'),

		m('びゃ', 'ビャ', 'bya'),
		m('びゅ', 'ビュ', 'byu'),
		m('びぇ', 'ビェ', 'bye'),
		m('びょ', 'ビョ', 'byo'),

		m('ぴゃ', 'ピャ', 'pya'),
		m('ぴゅ', 'ピュ', 'pyu'),
		m('ぴぇ', 'ピェ', 'pye'),
		m('ぴょ', 'ピョ', 'pyo'),

		m('ふぁ', 'ファ', 'fa'),
		m('ふぃ', 'フィ', 'fi'),
		m('ふぇ', 'フェ', 'fe'),
		m('ふぉ', 'フォ', 'fo'),

		m('みゃ', 'ミャ', 'mya'),
		m('みゅ', 'ミュ', 'myu'),
		m('みぇ', 'ミェ', 'mye'),
		m('みょ', 'ミョ', 'myo'),

		m('りゃ', 'リャ', 'rya'),
		m('りゅ', 'リュ', 'ryu'),
		m('りぇ', 'リェ', 'rye'),
		m('りょ', 'リョ', 'ryo'),

		// Override the archaic and rare characters with combinations

		m('うぃ', 'ウィ', 'wi'),
		m('うぇ', 'ウェ', 'we'),

		m('ゔぁ', 'ヴァ', 'va'),
		m('ゔぃ', 'ヴィ', 'vi'),
		m('ゔぇ', 'ヴェ', 've'),
		m('ゔぉ', 'ヴォ', 'vo'),
	]
}

/** Extra romaji triples for IME input only. */
function map_romaji_ime<T>(m: MapFn<T>): T[] {
	return [
		m('ぁ', 'ァ', 'xa'),
		m('ぃ', 'ィ', 'xi'),
		m('ぅ', 'ゥ', 'xu'),
		m('ぇ', 'ェ', 'xe'),
		m('ぉ', 'ォ', 'xo'),

		m('ゐ', 'ヰ', 'xwi'),
		m('ゑ', 'ヱ', 'xwe'),

		m('わ\u{3099}', 'ヷ', 'xva'),
		m('ゐ\u{3099}', 'ヸ', 'xvi'),
		m('ゑ\u{3099}', 'ヹ', 'xve'),
		m('を\u{3099}', 'ヺ', 'xvo'),

		m('ゃ', 'ャ', 'xya'),
		m('ゅ', 'ュ', 'xyu'),
		m('ょ', 'ョ', 'xyo'),

		m('っ', 'ッ', 'xtu'),
		m('っ', 'ッ', 'xtsu'),

		m('どぅ', 'ドゥ', 'xdu'),
		m('てぃ', 'ティ', 'xti'),
		m('でぃ', 'ディ', 'xdi'),

		m('ゎ', 'ヮ', 'xwa'),
		m('ゕ', 'ヵ', 'xka'),
		m('ゖ', 'ヶ', 'xke'),
	]
}

/** The standard romaji punctuation */
function map_romaji_punctuation<T>(mFn: MapFn<T>): T[] {
	const m = (r: string, k: string) => mFn(k, k, r)
	return [
		m(' ', '\u{3000}'),
		m('/', '・'), // Katakana Middle Dot
		m(',', '、'), // Ideographic Comma
		m('.', '。'), // Ideographic Full Stop
		m('[', '「'), // Left Corner Bracket
		m(']', '」'), // Right Corner Bracket
		m('«', '《'), // Left Double Angle Bracket
		m('»', '》'), // Right Double Angle Bracket
		m('!', '！'), // fullwidth exclamation mark
		m('"', '＂'), // fullwidth quotation mark
		m('#', '＃'), // fullwidth number sign
		m('$', '＄'), // fullwidth dollar sign
		m('%', '％'), // fullwidth percent sign
		m('&', '＆'), // fullwidth ampersand
		m(`'`, '＇'), // fullwidth apostrophe
		m('(', '（'), // fullwidth left parenthesis
		m(')', '）'), // fullwidth right parenthesis
		m('*', '＊'), // fullwidth asterisk
		m('+', '＋'), // fullwidth plus sign
		m(':', '：'), // fullwidth colon
		m(';', '；'), // fullwidth semicolon
		m('<', '＜'), // fullwidth less-than sign
		m('=', '＝'), // fullwidth equals sign
		m('>', '＞'), // fullwidth greater-than sign
		m('?', '？'), // fullwidth question mark
		m('@', '＠'), // fullwidth commercial at
		m('\\', '＼'), // fullwidth reverse solidus
		m('^', '＾'), // fullwidth circumflex accent
		m('_', '＿'), // fullwidth low line
		m('`', '｀'), // fullwidth grave accent
		m('{', '｛'), // fullwidth left curly bracket
		m('|', '｜'), // fullwidth vertical line
		m('}', '｝'), // fullwidth right curly bracket
		m('~', '～'), // fullwidth tilde

		// Monetary symbols
		m('¢', '￠'),
		m('£', '￡'),
		m('¬', '￢'),
		m('¯', '￣'),
		m('¥', '￥'),
		m('₩', '￦'),

		// Override the '-' generation from romaji to kana
		m('-', 'ー'),
	]
}

/**
 * Lower precedence symbols that are never generated from the romaji, but need
 * to be mapped to romaji as well.
 */
function map_extra_romaji_punctuation<T>(mFn: MapFn<T>): T[] {
	const m = (r: string, k: string) => mFn(k, k, r)
	return [
		m('-', 'ｰ'), // Halfwidth prolonged sound mark
		m('=', '゠'), // Katakana-Hiragana Double Hyphen
		m('<', '〈'), // Left Angle Bracket
		m('>', '〉'), // Right Angle Bracket
		m('[', '『'), // Left White Corner Bracket
		m(']', '』'), // Right White Corner Bracket
		m('[', '【'), // Left Black Lenticular Bracket
		m(']', '】'), // Right Black Lenticular Bracket
		m('{', '〔'), // Left Tortoise Shell Bracket
		m('}', '〕'), // Right Tortoise Shell Bracket
		m('[', '〖'), // Left White Lenticular Bracket
		m(']', '〗'), // Right White Lenticular Bracket
		m('{', '〘'), // Left White Tortoise Shell Bracket
		m('}', '〙'), // Right White Tortoise Shell Bracket
		m('[', '〚'), // Left White Square Bracket
		m(']', '〛'), // Right White Square Bracket
		m('~', '〜'), // Wave Dash
		m('"', '〝'), // Reversed Double Prime Quotation Mark
		m('"', '〞'), // Double Prime Quotation Mark
		m('"', '〟'), // Low Double Prime Quotation Mark

		// Fullwidth and halfwidth symbols
		m(',', '，'), // fullwidth comma
		m('-', '－'), // fullwidth hyphen-minus
		m('.', '．'), // fullwidth full stop
		m('/', '／'), // fullwidth solidus
		m('[', '［'), // fullwidth left square bracket
		m(']', '］'), // fullwidth right square bracket
		m('(', '｟'), // fullwidth left white parenthesis
		m(')', '｠'), // fullwidth right white parenthesis

		m('|', '￤'), // Fullwidth Broken Bar

		m('.', '｡'), // halfwidth ideographic full stop
		m('[', '｢'), // halfwidth left corner bracket
		m(']', '｣'), // halfwidth right corner bracket
		m(',', '､'), // halfwidth ideographic comma
		m('/', '･'), // halfwidth katakana middle dot

		m('|', '￨'), // halfwidth forms light vertical
		m('←', '￩'), // halfwidth leftwards arrow
		m('↑', '￪'), // halfwidth upwards arrow
		m('→', '￫'), // halfwidth rightwards arrow
		m('↓', '￬'), // halfwidth downwards arrow
		m('■', '￭'), // halfwidth black square
		m('○', '￮'), // halfwidth white circle
	]
}

/**
 * Fullwidth ASCII (roman) characters to romaji mappings
 */
function map_romaji_fullwidth_ascii<T>(mFn: MapFn<T>): T[] {
	const m = (r: string, k: string) => mFn(k, k, r)
	return [
		m('0', '０'),
		m('1', '１'),
		m('2', '２'),
		m('3', '３'),
		m('4', '４'),
		m('5', '５'),
		m('6', '６'),
		m('7', '７'),
		m('8', '８'),
		m('9', '９'),
		m('A', 'Ａ'),
		m('B', 'Ｂ'),
		m('C', 'Ｃ'),
		m('D', 'Ｄ'),
		m('E', 'Ｅ'),
		m('F', 'Ｆ'),
		m('G', 'Ｇ'),
		m('H', 'Ｈ'),
		m('I', 'Ｉ'),
		m('J', 'Ｊ'),
		m('K', 'Ｋ'),
		m('L', 'Ｌ'),
		m('M', 'Ｍ'),
		m('N', 'Ｎ'),
		m('O', 'Ｏ'),
		m('P', 'Ｐ'),
		m('Q', 'Ｑ'),
		m('R', 'Ｒ'),
		m('S', 'Ｓ'),
		m('T', 'Ｔ'),
		m('U', 'Ｕ'),
		m('V', 'Ｖ'),
		m('W', 'Ｗ'),
		m('X', 'Ｘ'),
		m('Y', 'Ｙ'),
		m('Z', 'Ｚ'),
		m('a', 'ａ'),
		m('b', 'ｂ'),
		m('c', 'ｃ'),
		m('d', 'ｄ'),
		m('e', 'ｅ'),
		m('f', 'ｆ'),
		m('g', 'ｇ'),
		m('h', 'ｈ'),
		m('i', 'ｉ'),
		m('j', 'ｊ'),
		m('k', 'ｋ'),
		m('l', 'ｌ'),
		m('m', 'ｍ'),
		m('n', 'ｎ'),
		m('o', 'ｏ'),
		m('p', 'ｐ'),
		m('q', 'ｑ'),
		m('r', 'ｒ'),
		m('s', 'ｓ'),
		m('t', 'ｔ'),
		m('u', 'ｕ'),
		m('v', 'ｖ'),
		m('w', 'ｗ'),
		m('x', 'ｘ'),
		m('y', 'ｙ'),
		m('z', 'ｚ'),
	]
}
