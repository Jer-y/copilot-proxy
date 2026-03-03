import { createServer } from 'node:net'
import process from 'node:process'
import consola from 'consola'

export function isPortInUseError(error: unknown): boolean {
  if (error instanceof Error) {
    if ('code' in error && (error as NodeJS.ErrnoException).code === 'EADDRINUSE')
      return true
    if (error.message.includes('address already in use'))
      return true
  }
  return false
}

export function checkPortAvailable(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', (err) => {
      reject(err)
    })
    server.listen(port, () => {
      server.close(() => resolve())
    })
  })
}

export function exitWithPortInUse(port: number): never {
  consola.error(`Port ${port} is already in use`)
  process.exit(1)
}
