export function isLugosOperatorMode(): boolean {
  return process.env.NEXT_PUBLIC_LUGOS_OPERATOR_MODE === '1'
}
