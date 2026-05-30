declare module "bs58" {
  export function encode(bytes: Uint8Array): string;
  export function decode(str: string): Uint8Array;
  export default { encode, decode };
}
