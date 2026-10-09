/**
 * Normalizes an Indian phone number to E.164 (+91XXXXXXXXXX). Toll-free numbers
 * (1800/1860) are kept as bare digits. Returns null for anything that doesn't look valid.
 */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (/^(1800|1860)\d{6,7}$/.test(digits)) return digits;
  let local = digits;
  if (local.length === 12 && local.startsWith('91')) local = local.slice(2);
  else if (local.length === 13 && local.startsWith('091')) local = local.slice(3);
  else if (local.length === 11 && local.startsWith('0')) local = local.slice(1);
  if (!/^[1-9]\d{9}$/.test(local)) return null;
  return `+91${local}`;
}

/** Splits a free-text phone field ("080 2222 3333; +91 98450 00000") into normalized numbers. */
export function parsePhoneList(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return uniq(
    raw
      .split(/[;,/|]/)
      .map((part) => normalizePhone(part))
      .filter((p): p is string => p !== null),
  );
}

export function extractPincode(text: string | null | undefined): string | null {
  if (!text) return null;
  const matches = text.match(/\b[1-9]\d{5}\b/g);
  return matches ? matches[matches.length - 1] : null;
}

export function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}

// Words too generic to tell two hospitals apart.
const NAME_STOPWORDS = new Set([
  'hospital', 'hospitals', 'the', 'and', 'of', 'in', 'at', 'a', 'pvt', 'ltd', 'private', 'limited', 'multi',
  'multispeciality', 'multispecialty', 'speciality', 'specialty', 'super', 'superspeciality', 'centre', 'center',
  'medical', 'clinic', 'nursing', 'home', 'institute', 'research', 'sciences', 'health', 'care', 'healthcare',
]);

export function nameTokens(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/['’]/g, '') // "Martha's" -> "marthas"
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t && !NAME_STOPWORDS.has(t)),
  );
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

/** Same word, allowing a typo or transliteration difference ("Shifa"/"Shifaa", "Sreeniwasa"/"Sreenivasa"). */
function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 4) return false;
  return editDistance(a, b) <= (Math.max(a.length, b.length) >= 8 ? 2 : 1);
}

/** Share of the shorter name's distinctive words that also appear in the other name (0..1). */
export function nameSimilarity(a: string, b: string): number {
  let shorter = [...nameTokens(a)];
  let longer = [...nameTokens(b)];
  if (shorter.length > longer.length) [shorter, longer] = [longer, shorter];
  if (shorter.length === 0) return 0;
  const shared = shorter.filter((t) => longer.some((u) => tokensMatch(t, u))).length;
  return shared / shorter.length;
}

/** Prefers the address that includes a pincode, then the more detailed one. */
export function pickAddress(a: string | null | undefined, b: string | null | undefined): string | null {
  const score = (s: string | null | undefined) => (s ? (extractPincode(s) ? 1000 : 0) + s.length : -1);
  const best = score(a) >= score(b) ? a : b;
  return best?.trim() || null;
}

const HOSPITAL_CATEGORY =
  /hospital|medical cent|medical college|nursing home|health cent|maternity|trauma|emergency|multi ?speciality|super ?speciality/i;

/** Google Maps' "hospitals" search also returns clinics, labs and pharmacies; keep hospitals only. */
export function isHospitalCategory(category: string | null | undefined): boolean {
  return !category || HOSPITAL_CATEGORY.test(category);
}

export function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
