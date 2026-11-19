import { NotDataError } from './errors'

/**
 * What a node may hold: JSON plus bigint. Object fields that are `undefined` are dropped, so `{ a:
 * undefined }` and `{}` are the same value.
 */
export type Data =
  | null
  | boolean
  | number
  | string
  | bigint
  | readonly Data[]
  | { readonly [field: string]: Data | undefined }

const BIGINT_FIELD = '$bigint'

const isPlainObject = (value: object) => {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Each enumerable own field, the ones encoding and freezing read, refusing an accessor so neither
 * runs the value's code.
 */
const dataFields = (value: object, path: string) =>
  Object.keys(value).map(name => {
    const field = Object.getOwnPropertyDescriptor(value, name)!
    if ('get' in field)
      throw new NotDataError(`${path}.${name}`, 'is an accessor, not a data field')
    return [name, field.value as unknown] as const
  })

const encodeObject = (value: object, path: string): string => {
  if (!isPlainObject(value)) throw new NotDataError(path, 'is not a plain object')
  const fields = dataFields(value, path)
    .filter(([, field]) => field !== undefined)
    .toSorted(([left], [right]) => (left < right ? -1 : 1))
  return `{${fields
    .map(([name, field]) => {
      if (name === BIGINT_FIELD) throw new NotDataError(path, `uses the reserved field ${name}`)
      return `${JSON.stringify(name)}:${encodeAt(field, `${path}.${name}`)}`
    })
    .join(',')}}`
}

/** A list holding only its items, each an enumerable data property, so freezing reaches every one. */
const encodeArray = (value: readonly unknown[], path: string) => {
  if (Object.getPrototypeOf(value) !== Array.prototype)
    throw new NotDataError(path, 'is not a plain array')
  if (
    Object.getOwnPropertyNames(value).length !== value.length + 1 ||
    Object.getOwnPropertySymbols(value).length > 0
  )
    throw new NotDataError(path, 'has a hole or a field besides its items')
  const items: string[] = []
  for (let index = 0; index < value.length; index++) {
    const item = Object.getOwnPropertyDescriptor(value, index)
    if (!item || 'get' in item || !item.enumerable)
      throw new NotDataError(`${path}[${index}]`, 'is not an enumerable data item')
    items.push(encodeAt(item.value, `${path}[${index}]`))
  }
  return `[${items.join(',')}]`
}

const encodeAt = (value: unknown, path: string): string => {
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new NotDataError(path, 'is not a finite number')
    return JSON.stringify(value)
  }
  if (typeof value === 'bigint') return `{"${BIGINT_FIELD}":"${value}"}`
  if (value === null) return 'null'
  if (typeof value !== 'object') throw new NotDataError(path, `is ${typeof value}`)
  if (Array.isArray(value)) return encodeArray(value, path)
  return encodeObject(value, path)
}

/**
 * The canonical text of a value: equal data always encodes the same way, so two encodings compare
 * equal exactly when the values do. Throws {@link NotDataError} for anything else.
 */
export const encode = (value: unknown) => encodeAt(value, '')

const freeze = (item: unknown): void => {
  if (typeof item !== 'object' || item === null) return
  for (const field of Object.values(item)) freeze(field)
  if (!Object.isFrozen(item)) Object.freeze(item)
}

/** Validates a value as data, freezes every container, and returns its {@link encode} text. */
export const encodeFrozen = (value: unknown) => {
  const text = encode(value)
  freeze(value)
  return text
}

/** Validates a value as data and freezes every container before returning it. */
export const freezeData = (value: unknown): Data => {
  encodeFrozen(value)
  return value as Data
}

const reviveBigint = (_field: string, value: unknown) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const fields = Object.keys(value)
  if (fields.length !== 1 || fields[0] !== BIGINT_FIELD) return value
  const digits = (value as Record<string, unknown>)[BIGINT_FIELD]
  return typeof digits === 'string' ? BigInt(digits) : value
}

export const decode = (text: string): Data => JSON.parse(text, reviveBigint)

/**
 * `value` as a journal reads it back, `decode(encode(value))`, frozen to any depth, with `value`
 * frozen too, and the canonical text it went through. Throws {@link NotDataError} for anything that
 * is not data.
 */
export const roundTripText = (value: unknown) => {
  const text = encode(value)
  const held: Data = decode(text)
  freeze(value)
  freeze(held)
  return { held, text }
}
