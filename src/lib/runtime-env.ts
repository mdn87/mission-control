export async function getEffectiveEnvValue(key: string): Promise<string> {
  return process.env[key] || ''
}
