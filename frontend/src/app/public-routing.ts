export const productIntroHash = "#/about";
export const productPrivacyHash = `${productIntroHash}?section=privacy`;

export function isProductIntroHash(hash: string): boolean {
  return hash.split("?")[0].replace(/\/+$/, "") === productIntroHash;
}
