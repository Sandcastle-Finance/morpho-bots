import { describe, expect, it } from 'vitest'

import { tryCatch } from '../../src/helpers/tryCatch'

describe('tryCatch', () => {
  describe('synchronous function form', () => {
    it('should return success result with data when function returns', () => {
      const result = tryCatch(() => 42)

      expect(result).toEqual({ data: 42, error: null })
    })

    it('should return failure result with error when function throws', () => {
      const error = new Error('test error')
      const result = tryCatch(() => {
        throw error
      })

      expect(result.data).toBeNull()
      expect(result.error).toBeInstanceOf(Error)
      expect(result.error?.message).toBe('test error')
    })

    it('should handle non-Error throws and convert to Error', () => {
      const result = tryCatch(() => {
        throw 'string error'
      })

      expect(result.data).toBeNull()
      expect(result.error).toBeInstanceOf(Error)
      expect(result.error?.message).toContain('This value was thrown as is')
    })

    it('should preserve error properties', () => {
      const error = new Error('test')
      error.cause = 'root cause'
      const result = tryCatch(() => {
        throw error
      })

      expect(result.error?.cause).toBe('root cause')
    })
  })

  describe('promise form', () => {
    it('should return success result with data when promise resolves', async () => {
      const result = await tryCatch(Promise.resolve(42))

      expect(result).toEqual({ data: 42, error: null })
    })

    it('should return failure result with error when promise rejects', async () => {
      const error = new Error('test error')
      const result = await tryCatch(Promise.reject(error))

      expect(result.data).toBeNull()
      expect(result.error).toBeInstanceOf(Error)
      expect(result.error?.message).toBe('test error')
    })

    it('should handle non-Error rejections and convert to Error', async () => {
      const result = await tryCatch(Promise.reject('string error'))

      expect(result.data).toBeNull()
      expect(result.error).toBeInstanceOf(Error)
      expect(result.error?.message).toContain('This value was thrown as is')
    })

    it('should preserve error properties', async () => {
      const error = new Error('test')
      error.cause = 'root cause'
      const result = await tryCatch(Promise.reject(error))

      expect(result.error?.cause).toBe('root cause')
    })
  })

  // The deploy scripts pass execa subprocesses here. Those are thenables that are NOT native
  // Promises, yet execa's typings declare them `extends Promise<Result>` — so a check of
  // `fn instanceof Promise` type-checks fine and then takes the sync path at runtime, calling the
  // subprocess object and reporting `fn is not a function` as if the command itself had failed.
  describe('thenable (non-Promise) form', () => {
    const thenable = <T>(value: T) => ({
      // oxlint-disable-next-line unicorn/no-thenable -- a non-Promise thenable IS the subject here
      then: (resolve: (value: T) => void) => {
        resolve(value)
      }
    })
    const rejecting = (reason: unknown) => ({
      // oxlint-disable-next-line unicorn/no-thenable -- as above; stands in for execa's subprocess
      then: (_resolve: (value: never) => void, reject: (reason: unknown) => void) => {
        reject(reason)
      }
    })

    it('should resolve a thenable that is not a Promise instance', async () => {
      const subject = thenable(42)
      expect(subject).not.toBeInstanceOf(Promise)

      const result = await tryCatch(subject as unknown as Promise<number>)

      expect(result).toEqual({ data: 42, error: null })
    })

    it('should capture a thenable rejection as an error rather than calling it', async () => {
      const result = await tryCatch(rejecting(new Error('boom')) as unknown as Promise<never>)

      expect(result.data).toBeNull()
      expect(result.error?.message).toBe('boom')
      expect(result.error?.message).not.toContain('is not a function')
    })
  })

  describe('custom error types', () => {
    class CustomError extends Error {
      code: number
      constructor(message: string, code: number) {
        super(message)
        this.code = code
      }
    }

    it('should preserve custom error type in sync form', () => {
      const result = tryCatch<never, CustomError>(() => {
        throw new CustomError('custom', 42)
      })

      expect(result.error).toBeInstanceOf(CustomError)
      expect((result.error as CustomError).code).toBe(42)
    })

    it('should preserve custom error type in async form', async () => {
      const result = await tryCatch<never, CustomError>(
        Promise.reject(new CustomError('async', 99))
      )

      expect(result.error).toBeInstanceOf(CustomError)
      expect((result.error as CustomError).code).toBe(99)
    })
  })
})
