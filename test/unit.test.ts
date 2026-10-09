import assert from 'node:assert/strict';
import { test } from 'node:test';
import { haversineKm, isInIndia, zoomForArea } from '../src/geo';
import { extractPincode, isHospitalCategory, nameSimilarity, normalizePhone, parsePhoneList, pickAddress } from '../src/normalize';
import { parsePlaceHref, parseResultCard } from '../src/sources/googleMaps';
import { mergeHospital } from '../src/store';
import type { HospitalRow } from '../src/types';

test('haversine: MG Road to Koramangala is ~5 km', () => {
  const d = haversineKm({ lat: 12.9756, lng: 77.6066 }, { lat: 12.9352, lng: 77.6245 });
  assert.ok(d > 4.5 && d < 5.0, `got ${d}`);
});

test('India bounds', () => {
  assert.ok(isInIndia(12.97, 77.59));
  assert.ok(isInIndia(28.61, 77.21));
  assert.ok(!isInIndia(51.5, -0.12));
});

test('Google Maps zoom for an area', () => {
  assert.ok(zoomForArea(8, 13) >= 13 && zoomForArea(8, 13) <= 15);
  assert.ok(zoomForArea(2, 13) > zoomForArea(8, 13));
});

test('phone normalization', () => {
  assert.equal(normalizePhone('080 4019 4444'), '+918040194444');
  assert.equal(normalizePhone('096868 60310'), '+919686860310');
  assert.equal(normalizePhone('+91 98450 12345'), '+919845012345');
  assert.equal(normalizePhone('1800 102 4647'), '18001024647');
  assert.equal(normalizePhone('12345'), null);
  assert.deepEqual(parsePhoneList('+918022868423;080 2220 3333'), ['+918022868423', '+918022203333']);
});

test('pincode and address helpers', () => {
  assert.equal(extractPincode('Rajajinagar, Bengaluru, Karnataka 560021'), '560021');
  assert.equal(extractPincode('no pin here'), null);
  assert.equal(pickAddress('14, Cunningham Rd', '14, Cunningham Rd, Bengaluru, Karnataka 560052'), '14, Cunningham Rd, Bengaluru, Karnataka 560052');
});

test('name similarity ignores generic words', () => {
  assert.equal(nameSimilarity('Fortis Hospital', 'Fortis Hospital - Cunningham Road, Bengaluru'), 1);
  assert.equal(nameSimilarity('Manipal Hospital', 'Fortis Hospital'), 0);
});

test('hospital category filter', () => {
  assert.ok(isHospitalCategory('Private hospital'));
  assert.ok(isHospitalCategory('Children\'s hospital'));
  assert.ok(isHospitalCategory(null));
  assert.ok(!isHospitalCategory('Diagnostic center'));
  assert.ok(!isHospitalCategory('Pharmacy'));
});

const FORTIS_HREF =
  'https://www.google.com/maps/place/Fortis+Hospital/data=!4m7!3m6!1s0x3bae166847800b0f:0x5670f48c68782ac8!8m2!3d12.9883289!4d77.5943834!16s%2Fg%2F1vr3bm6g!19sChIJDwuAR2gWrjsRyCp4aIz0cFY?authuser=0&hl=en';

test('Google Maps place URL parsing', () => {
  assert.deepEqual(parsePlaceHref(FORTIS_HREF), { lat: 12.9883289, lng: 77.5943834, placeId: 'ChIJDwuAR2gWrjsRyCp4aIz0cFY' });
  assert.equal(parsePlaceHref('https://www.google.com/maps/search/hospitals'), null);
});

test('Google Maps result card parsing', () => {
  const name = 'Fortis Hospital - Cunningham Road, Bengaluru';
  const card = parseResultCard({
    name,
    href: FORTIS_HREF,
    text: `${name}\n${name}\n4.6\nHospital ·  · 14, Cunningham Rd, near Sigma Central Mall\nOpen 24 hours · 096868 60310\n\nWebsite\n\nDirections`,
  });
  assert.ok(card);
  assert.equal(card.category, 'Hospital');
  assert.equal(card.address, '14, Cunningham Rd, near Sigma Central Mall');
  assert.deepEqual(card.phones, ['+919686860310']);
  assert.equal(card.rating, 4.6);
  assert.equal(card.open24h, true);
});

test('merge: Google data wins, OSM fills gaps, lists are unioned', () => {
  const osmRow: HospitalRow = {
    id: 'x', name: 'Fortis Hospital', address: 'Cunningham Road', pincode: null, phones: ['+918066214444'],
    website: 'https://fortis.example', category: 'Hospital', specialties: ['Cardiology'], open_24_hours: null,
    emergency: true, rating: null, review_count: null, lat: 12.988, lng: 77.594, osm_id: 'node/1',
    google_place_id: null, google_url: null, sources: ['osm'], google_details_at: null, google_checked_at: null,
    updated_at: new Date(),
  };
  const merged = mergeHospital(osmRow, {
    source: 'google_maps', name: 'Fortis Hospital - Cunningham Road', lat: 12.9883, lng: 77.5944,
    address: '14, Cunningham Rd, Bengaluru, Karnataka 560052', phones: ['+919686860310'], specialties: [],
    category: 'Private hospital', rating: 4.6, googlePlaceId: 'ChIJabc', googleDetailed: true,
  });
  assert.equal(merged.name, 'Fortis Hospital - Cunningham Road');
  assert.equal(merged.pincode, '560052');
  assert.deepEqual(merged.phones, ['+919686860310', '+918066214444']);
  assert.equal(merged.website, 'https://fortis.example');
  assert.equal(merged.emergency, true);
  assert.deepEqual(merged.specialties, ['Cardiology']);
  assert.equal(merged.osm_id, 'node/1');
  assert.equal(merged.google_place_id, 'ChIJabc');
  assert.deepEqual(merged.sources, ['osm', 'google_maps']);
  assert.ok(merged.google_details_at instanceof Date);
});

test('name similarity tolerates spelling variants', () => {
  assert.equal(nameSimilarity('Shifa Hospital, Bengaluru Urban', 'Shifaa Hospital'), 1);
  assert.equal(nameSimilarity('Sreeniwasa Hospital', 'SREENIVASA HOSPITAL'), 1);
  assert.equal(nameSimilarity('St Marthas Hospital', "St. Martha's Hospital"), 1);
  assert.equal(nameSimilarity('Amar Hospital', 'Shekar Hospital'), 0);
});

test('merge: a duplicate Google listing only fills gaps and keeps the shorter name', () => {
  const googleRow: HospitalRow = {
    id: 'x', name: 'Best Emergency Hospital in Bangalore | Fortis Hospital Cunningham Road', address: null,
    pincode: null, phones: ['+919686860310'], website: 'https://fortis.example/seo?utm_source=gmb',
    category: 'Emergency care service', specialties: [], open_24_hours: true, emergency: null, rating: 5,
    review_count: 2, lat: 12.9883, lng: 77.5944, osm_id: null, google_place_id: 'ChIJseo', google_url: null,
    sources: ['google_maps'], google_details_at: null, google_checked_at: null, updated_at: new Date(),
  };
  const merged = mergeHospital(googleRow, {
    source: 'google_maps', name: 'Fortis Hospital - Cunningham Road', lat: 12.9883, lng: 77.5944,
    address: '14, Cunningham Rd, Bengaluru, Karnataka 560052', phones: ['+918066214444'], specialties: [],
    website: 'https://www.fortishealthcare.com', category: 'Private hospital', rating: 4.6, googlePlaceId: 'ChIJmain',
  });
  assert.equal(merged.name, 'Fortis Hospital - Cunningham Road');
  assert.equal(merged.address, '14, Cunningham Rd, Bengaluru, Karnataka 560052');
  assert.deepEqual(merged.phones, ['+919686860310', '+918066214444']);
  assert.equal(merged.category, 'Emergency care service');
  assert.equal(merged.google_place_id, 'ChIJseo');
});
