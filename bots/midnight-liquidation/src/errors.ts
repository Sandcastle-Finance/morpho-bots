/** Raised when a discovery page has no `data` array, so the read cannot vouch for anything. */
export class MalformedPageError extends Error {
  constructor(source: string) {
    super(`${source} returned a page without a data array`)
    this.name = 'MalformedPageError'
  }
}

/** Raised when a required env var is missing or malformed — the bot must fail loud at startup. */
export class InvalidConfigError extends Error {
  readonly code = 'invalid_config'

  constructor(message: string) {
    super(message)
    this.name = 'InvalidConfigError'
  }
}

/** Raised when the latest block carries no base fee, so a liquidation's gas cannot be priced. */
export class MissingBaseFeeError extends Error {
  constructor(chainId: number) {
    super(`chain ${chainId} reported a block without a base fee`)
    this.name = 'MissingBaseFeeError'
  }
}

/** A settings record broke its schema; it names each field, never a value. */
export class InvalidSettingsError extends Error {
  constructor(readonly fields: readonly string[]) {
    super(`invalid liquidator settings: ${fields.join(', ')}`)
    this.name = 'InvalidSettingsError'
  }
}

/** The live kernel's account or chain is not the one its settings record. */
export class SettingsMismatchError extends Error {
  constructor(readonly field: 'account' | 'chainId') {
    super(`the live kernel's ${field} differs from its settings`)
    this.name = 'SettingsMismatchError'
  }
}

/** A journal whose graph this bot cannot rebuild. */
export class NotReplayableError extends Error {
  constructor(reason: string) {
    super(`the journal cannot be replayed: ${reason}`)
    this.name = 'NotReplayableError'
  }
}

/** A replayed graph reached for an effect, which replay never runs. */
export class ReplayEffectError extends Error {
  constructor() {
    super('a replay reached for an effect')
    this.name = 'ReplayEffectError'
  }
}
