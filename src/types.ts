export type Source = 'osm' | 'google_maps';

/** A hospital as seen by one source, before it is merged into the database. */
export interface HospitalCandidate {
  source: Source;
  name: string;
  lat: number;
  lng: number;
  address?: string | null;
  pincode?: string | null;
  phones: string[];
  website?: string | null;
  category?: string | null;
  specialties: string[];
  open24h?: boolean | null;
  emergency?: boolean | null;
  rating?: number | null;
  reviewCount?: number | null;
  osmId?: string | null;
  googlePlaceId?: string | null;
  googleUrl?: string | null;
  /** True when the Google Maps place page itself was scraped (full address, all phones). */
  googleDetailed?: boolean;
}

export interface HospitalRow {
  id: string;
  name: string;
  address: string | null;
  pincode: string | null;
  phones: string[];
  website: string | null;
  category: string | null;
  specialties: string[];
  open_24_hours: boolean | null;
  emergency: boolean | null;
  rating: number | null;
  review_count: number | null;
  lat: number;
  lng: number;
  osm_id: string | null;
  google_place_id: string | null;
  google_url: string | null;
  sources: string[];
  google_details_at: Date | null;
  google_checked_at: Date | null;
  updated_at: Date;
}
