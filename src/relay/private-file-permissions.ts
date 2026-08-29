import { posix } from 'node:path'

export interface FilePermissionMetadata {
  mode: number
  uid: number
  gid: number
}

export function privateFilePermissionsAreSafe(
  absolutePath: string,
  metadata: FilePermissionMetadata,
  credentialsDirectory: string | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === 'win32' || (metadata.mode & 0o077) === 0) return true
  if (platform !== 'linux' || !credentialsDirectory) return false

  const normalizedDirectory = posix.normalize(credentialsDirectory)
  const normalizedPath = posix.normalize(absolutePath)
  return normalizedDirectory.startsWith('/run/credentials/')
    && posix.dirname(normalizedPath) === normalizedDirectory
    && metadata.uid === 0
    && metadata.gid === 0
    // LoadCredential grants the service user an ACL. Its mask appears in the
    // group mode bits even though the owning root group has no file access.
    && (metadata.mode & 0o777) === 0o440
}
