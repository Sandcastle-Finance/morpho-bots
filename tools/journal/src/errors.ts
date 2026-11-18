/** A command the CLI will not run as asked: bad arguments, an unreadable file, or a build it cannot replay. */
export class JournalRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JournalRefusedError'
  }
}
