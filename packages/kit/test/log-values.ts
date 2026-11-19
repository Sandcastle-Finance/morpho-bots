/** Every primitive a record carries, depth first, whatever its field names. */
export const leaves = (value: unknown): unknown[] =>
  value !== null && typeof value === 'object' ? Object.values(value).flatMap(leaves) : [value]

/** Every plain object in a record, the record itself included. */
export const objects = (value: unknown): object[] =>
  value !== null && typeof value === 'object'
    ? [...(Array.isArray(value) ? [] : [value]), ...Object.values(value).flatMap(objects)]
    : []

/** Every list in a record. */
export const lists = (value: unknown): unknown[][] =>
  value !== null && typeof value === 'object'
    ? [...(Array.isArray(value) ? [value] : []), ...Object.values(value).flatMap(lists)]
    : []

/** The primitives of every object in a record that names `subject` as one of its own values. */
export const about = (record: unknown, subject: unknown) =>
  objects(record)
    .filter(item => Object.values(item).includes(subject))
    .map(leaves)
