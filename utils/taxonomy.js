/**
 * Controlled vocabulary shared between:
 *  - the statute metadata backfill (db/migrations/classifyLawMetadata.js)
 *  - structured query extraction (utils/queryUnderstanding.js)
 *
 * Both directions MUST draw from the same lists, otherwise metadata filtering
 * degenerates back into free-text string matching.
 */

export const TOPICS = [
  "AED",
  "CPR Training",
  "Trauma Kits",
  "Emergency Medical",
  "Good Samaritan Protection",
  "Building Code",
  "OSHA / Workplace Safety",
  "Licensing",
  "Other",
];

export const INDUSTRIES = [
  "K-12 Education",
  "Higher Education",
  "Government",
  "Health Club / Fitness Studio / Gym",
  "Dental Office",
  "Medical / Healthcare Facility",
  "Passenger Railways",
  "Aviation",
  "Assisted Living",
  "Community Care Facility",
  "Youth Sports / Athletics",
  "Public Pool / Aquatics",
  "Law Enforcement",
  "General Business",
  "Construction / Building Code",
  "Other",
];

export const FACILITY_TYPES = [
  "Health Club",
  "Gym",
  "K-12 School",
  "College / University",
  "Dental Office",
  "Hospital / Medical Facility",
  "Passenger Rail Car",
  "Airport",
  "Assisted Living Facility",
  "Community Care Facility",
  "Youth Sports Facility",
  "Public Swimming Pool",
  "Government Building",
  "General Business Premises",
  "Residential Building",
  "Other",
];

export const DOCUMENT_TYPES = ["statute", "bill"];

export const FACILITY_STATUSES = ["New Construction", "Existing Facility", "Renovation"];
