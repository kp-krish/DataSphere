/**
 * Vocabulary used to synthesise the star schema.
 *
 * The goal is data that *reads* like a real retail dataset when you open a
 * dashboard: recognisable category hierarchies, plausible city/region/country
 * combinations, brands that repeat across products. Random hex strings would
 * seed just as fast but make every chart meaningless to look at, which
 * defeats the point of a visualization portfolio project.
 */

export const FIRST_NAMES = [
  'Aisha', 'Liam', 'Priya', 'Mateo', 'Sofia', 'Noah', 'Yuki', 'Elena', 'Omar', 'Chloe',
  'Ravi', 'Hana', 'Diego', 'Amara', 'Lucas', 'Nadia', 'Ethan', 'Zara', 'Felix', 'Ingrid',
  'Tomas', 'Leila', 'Arjun', 'Marta', 'Kai', 'Beatriz', 'Sven', 'Naomi', 'Idris', 'Clara',
  'Hugo', 'Anika', 'Pedro', 'Freya', 'Jonas', 'Mei', 'Rafael', 'Sanne', 'Yusuf', 'Talia',
] as const;

export const LAST_NAMES = [
  'Okafor', 'Nakamura', 'Silva', 'Muller', 'Kowalski', 'Rossi', 'Dubois', 'Andersen',
  'Fernandez', 'Novak', 'Haddad', 'Lindqvist', 'Petrov', 'Bakker', 'Moreau', 'Costa',
  'Schneider', 'Iyer', 'Kimura', 'Almeida', 'Larsen', 'Varga', 'Sokolov', 'Reyes',
  'Marchetti', 'Fitzgerald', 'Nowak', 'Oyelaran', 'Vermeulen', 'Bianchi', 'Halvorsen',
  'Rahman', 'Castillo', 'Jansen', 'Toledo', 'Weber', 'Sandoval', 'Bergstrom', 'Aziz', 'Duarte',
] as const;

export const EMAIL_DOMAINS = [
  'example.com', 'mailbox.test', 'demo-corp.example', 'inbox.example', 'northwind.example',
] as const;

export const CUSTOMER_SEGMENTS = [
  ['Consumer', 45],
  ['Corporate', 30],
  ['Home Office', 15],
  ['Small Business', 10],
] as const;

/**
 * Geography, structured so that country -> region -> city is always
 * internally consistent. A dashboard grouped by region should never show a
 * city that does not belong to it.
 */
export interface GeoEntry {
  country: string;
  region: string;
  cities: readonly string[];
}

export const GEOGRAPHY: readonly GeoEntry[] = [
  { country: 'United States', region: 'West',      cities: ['Seattle', 'Portland', 'San Francisco', 'Los Angeles', 'Phoenix', 'Denver'] },
  { country: 'United States', region: 'Northeast', cities: ['New York', 'Boston', 'Philadelphia', 'Pittsburgh'] },
  { country: 'United States', region: 'South',     cities: ['Austin', 'Atlanta', 'Miami', 'Nashville', 'Dallas'] },
  { country: 'United States', region: 'Midwest',   cities: ['Chicago', 'Detroit', 'Minneapolis', 'Columbus'] },
  { country: 'Canada',        region: 'Central',   cities: ['Toronto', 'Ottawa', 'Winnipeg'] },
  { country: 'Canada',        region: 'West',      cities: ['Vancouver', 'Calgary', 'Edmonton'] },
  { country: 'United Kingdom',region: 'England',   cities: ['London', 'Manchester', 'Bristol', 'Leeds'] },
  { country: 'United Kingdom',region: 'Scotland',  cities: ['Edinburgh', 'Glasgow'] },
  { country: 'Germany',       region: 'Bavaria',   cities: ['Munich', 'Nuremberg'] },
  { country: 'Germany',       region: 'NRW',       cities: ['Cologne', 'Dusseldorf', 'Dortmund'] },
  { country: 'France',        region: 'Ile-de-France', cities: ['Paris', 'Versailles'] },
  { country: 'France',        region: 'Occitanie', cities: ['Toulouse', 'Montpellier'] },
  { country: 'Spain',         region: 'Catalonia', cities: ['Barcelona', 'Girona'] },
  { country: 'Netherlands',   region: 'Randstad',  cities: ['Amsterdam', 'Rotterdam', 'Utrecht'] },
  { country: 'Japan',         region: 'Kanto',     cities: ['Tokyo', 'Yokohama'] },
  { country: 'Japan',         region: 'Kansai',    cities: ['Osaka', 'Kyoto'] },
  { country: 'Australia',     region: 'NSW',       cities: ['Sydney', 'Newcastle'] },
  { country: 'Australia',     region: 'Victoria',  cities: ['Melbourne', 'Geelong'] },
  { country: 'Brazil',        region: 'Southeast', cities: ['Sao Paulo', 'Rio de Janeiro'] },
  { country: 'India',         region: 'Maharashtra', cities: ['Mumbai', 'Pune'] },
];

/**
 * Product taxonomy. `priceBand` sets the centre of the cost distribution for
 * the subcategory, so accessories stay cheap and laptops stay expensive - the
 * thing that makes "revenue by category" charts look like a real business.
 */
export interface SubcategorySpec {
  name: string;
  /** Mean unit cost in currency units. */
  meanCost: number;
  /** Standard deviation of unit cost. */
  costStdDev: number;
  /** Relative share of the catalogue. */
  weight: number;
}

export interface CategorySpec {
  name: string;
  subcategories: readonly SubcategorySpec[];
}

export const PRODUCT_TAXONOMY: readonly CategorySpec[] = [
  {
    name: 'Technology',
    subcategories: [
      { name: 'Laptops',     meanCost: 720, costStdDev: 220, weight: 12 },
      { name: 'Phones',      meanCost: 430, costStdDev: 150, weight: 14 },
      { name: 'Monitors',    meanCost: 210, costStdDev: 80,  weight: 10 },
      { name: 'Accessories', meanCost: 26,  costStdDev: 14,  weight: 22 },
      { name: 'Networking',  meanCost: 95,  costStdDev: 45,  weight: 8 },
    ],
  },
  {
    name: 'Furniture',
    subcategories: [
      { name: 'Chairs',      meanCost: 165, costStdDev: 60, weight: 12 },
      { name: 'Desks',       meanCost: 290, costStdDev: 95, weight: 9 },
      { name: 'Bookcases',   meanCost: 130, costStdDev: 50, weight: 6 },
      { name: 'Furnishings', meanCost: 48,  costStdDev: 22, weight: 10 },
    ],
  },
  {
    name: 'Office Supplies',
    subcategories: [
      { name: 'Paper',       meanCost: 9,   costStdDev: 4,  weight: 20 },
      { name: 'Binders',     meanCost: 14,  costStdDev: 6,  weight: 16 },
      { name: 'Storage',     meanCost: 38,  costStdDev: 16, weight: 12 },
      { name: 'Art',         meanCost: 17,  costStdDev: 8,  weight: 9 },
      { name: 'Labels',      meanCost: 7,   costStdDev: 3,  weight: 8 },
    ],
  },
  {
    name: 'Apparel',
    subcategories: [
      { name: 'Outerwear',   meanCost: 88,  costStdDev: 35, weight: 8 },
      { name: 'Footwear',    meanCost: 62,  costStdDev: 26, weight: 10 },
      { name: 'Workwear',    meanCost: 41,  costStdDev: 18, weight: 9 },
    ],
  },
];

export const BRANDS = [
  'Northwind', 'Acme', 'Lumen', 'Vertex', 'Cobalt', 'Harbour', 'Kestrel', 'Meridian',
  'Solstice', 'Ironwood', 'Aster', 'Nimbus', 'Corvus', 'Halcyon', 'Basalt', 'Juniper',
  'Pinnacle', 'Zephyr', 'Quarry', 'Alder',
] as const;

export const PRODUCT_MODIFIERS = [
  'Pro', 'Lite', 'Max', 'Essential', 'Studio', 'Compact', 'Ultra', 'Classic', 'Prime',
  'Series 2', 'Series 3', 'XL', 'Mini', 'Edge', 'Core',
] as const;

export const STORE_CHANNELS = [
  ['Retail', 50],
  ['Online', 25],
  ['Wholesale', 15],
  ['Partner', 10],
] as const;

export const ORDER_STATUSES = [
  ['completed', 88],
  ['pending', 5],
  ['returned', 4],
  ['cancelled', 3],
] as const;

export const DAY_NAMES = [
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
] as const;

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/**
 * Multiplicative demand factor per calendar month (index 0 = January).
 * Retail peaks hard in November and December and slumps in January and
 * February. Without this the time-series charts are a flat noise band, and a
 * date-range filter is uniformly selective no matter which range you pick.
 */
export const MONTH_SEASONALITY = [
  0.78, 0.74, 0.92, 0.95, 1.02, 0.98,
  0.94, 0.96, 1.06, 1.14, 1.48, 1.62,
] as const;

/**
 * Multiplicative factor per ISO weekday (index 0 = Monday). Orders dip at the
 * weekend for a business selling largely to other businesses.
 */
export const WEEKDAY_SEASONALITY = [
  1.12, 1.15, 1.14, 1.10, 1.02, 0.62, 0.55,
] as const;

/**
 * Year-over-year growth applied on top of seasonality, so the fact table has
 * a visible upward trend rather than a stationary series.
 */
export const ANNUAL_GROWTH_RATE = 0.18;
