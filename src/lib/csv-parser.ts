import { ProductData, CustomerData, OrderData, Address, LineItem } from '@/types/database';

/**
 * Parse delimiter-separated CSV (DanDomain exports are often semicolon-separated).
 * This parser:
 * - Detects delimiter (; , \t) from the header row
 * - Handles quoted values ("...") and escaped quotes ("")
 * - Handles Windows newlines (\r\n) and BOM
 */
function parseCSV(csvText: string): Record<string, string>[] {
  const normalized = (csvText || '')
    .replace(/^\uFEFF/, '') // BOM
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();

  if (!normalized) return [];

  // Parse CSV handling multiline quoted fields
  // DanDomain exports have HTML content with newlines inside quoted fields
  const logicalLines = splitIntoLogicalLines(normalized);
  
  if (logicalLines.length < 2) return [];

  // DanDomain exports often have a single-word entity name on the first line
  // e.g. "PRODUCTS", "CUSTOMERS", "ORDERS", "PRODUCTCATEGORIES"
  let startLine = 0;
  const firstLineDelimiter = detectDelimiter(logicalLines[0]);
  const firstLineParts = splitDelimitedLine(logicalLines[0], firstLineDelimiter);
  
  // If first line has only one part and it looks like an entity name, skip it
  if (firstLineParts.length === 1 && /^[A-Z_]+$/i.test(cleanCell(firstLineParts[0]))) {
    console.log('Skipping entity name line:', logicalLines[0]);
    startLine = 1;
  }

  if (logicalLines.length - startLine < 2) return [];

  const headerLine = logicalLines[startLine];
  const delimiter = detectDelimiter(headerLine);

  const headers = splitDelimitedLine(headerLine, delimiter).map((h) => cleanCell(h));
  
  console.log('CSV parsing - headers detected:', headers.slice(0, 5), '... total:', headers.length);

  const rows: Record<string, string>[] = [];
  for (let i = startLine + 1; i < logicalLines.length; i++) {
    const line = logicalLines[i];
    if (!line.trim()) continue;
    
    const values = splitDelimitedLine(line, delimiter).map((v) => cleanCell(v));
    const row: Record<string, string> = {};

    headers.forEach((header, index) => {
      row[header] = values[index] ?? '';
    });

    // Only add rows that have at least one non-empty value
    if (Object.values(row).some(v => v !== '')) {
      rows.push(row);
    }
  }

  return rows;
}

/**
 * Split CSV text into logical lines, respecting quoted fields that span multiple lines
 * DanDomain exports have HTML content with embedded newlines inside quoted fields
 */
function splitIntoLogicalLines(text: string): string[] {
  const lines: string[] = [];
  let currentLine = '';
  let inQuotes = false;
  
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    
    if (ch === '"') {
      // Check for escaped quote ""
      if (inQuotes && text[i + 1] === '"') {
        currentLine += '""';
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      currentLine += ch;
      continue;
    }
    
    if (ch === '\n' && !inQuotes) {
      // End of logical line
      if (currentLine.trim()) {
        lines.push(currentLine);
      }
      currentLine = '';
      continue;
    }
    
    currentLine += ch;
  }
  
  // Don't forget the last line
  if (currentLine.trim()) {
    lines.push(currentLine);
  }
  
  return lines;
}

function detectDelimiter(line: string): ';' | ',' | '\t' {
  const candidates: Array<';' | ',' | '\t'> = [';', ',', '\t'];
  const counts = candidates.map((d) => ({ d, n: (line.split(d).length - 1) }));
  counts.sort((a, b) => b.n - a.n);
  // Default to semicolon if uncertain
  if (counts[0].n === 0) return ';';
  return counts[0].d;
}

function splitDelimitedLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      // Escaped quote inside quotes
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }

    if (!inQuotes && ch === delimiter) {
      out.push(current);
      current = '';
      continue;
    }

    current += ch;
  }

  out.push(current);
  return out;
}

function cleanCell(value: string): string {
  return (value ?? '').trim();
}

/**
 * Parse DanDomain price format (comma as decimal separator)
 */
function parsePrice(priceStr: string): number {
  if (!priceStr) return 0;
  return parseFloat(priceStr.replace(',', '.').replace(/[^\d.-]/g, '')) || 0;
}

/**
 * Parse DanDomain date format (DD-MM-YYYY HH:MM:SS) to ISO
 */
function parseDate(dateStr: string): string {
  if (!dateStr) return new Date().toISOString();
  
  const match = dateStr.match(/(\d{2})-(\d{2})-(\d{4})\s*(\d{2})?:?(\d{2})?:?(\d{2})?/);
  if (!match) return new Date().toISOString();
  
  const [, day, month, year, hour = '00', minute = '00', second = '00'] = match;
  return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}`).toISOString();
}

/**
 * Parse products CSV from DanDomain
 */
export function parseProductsCSV(csvText: string): ProductData[] {
  const rows = parseCSV(csvText);

  const parseCategoryIds = (raw: string | undefined): string[] => {
    const value = (raw || '').trim();
    if (!value) return [];

    // DanDomain sometimes provides multiple category ids in one field separated by '#'
    // e.g. "166#6#97" -> ["166","6","97"]
    return value
      .split('#')
      .map((s) => s.trim())
      .filter((s) => s && !s.includes('#'));
  };
  
  return rows.map(row => ({
    title: row['PROD_NAME'] || row['title'] || 'Untitled',
    body_html: row['PROD_DESCRIPTION'] || row['description'] || '',
    short_description: row['PROD_SHORT_DESCRIPTION'] || '',
    sku: row['PROD_NUM'] || row['sku'] || `SKU-${Date.now()}`,
    price: parsePrice(row['PROD_PRICE'] || row['price']),
    compare_at_price: row['PROD_PRICE_OFFER'] ? parsePrice(row['PROD_PRICE_OFFER']) : null,
    weight: row['PROD_WEIGHT'] ? parseFloat(row['PROD_WEIGHT'].replace(',', '.')) : null,
    stock_quantity: parseInt(row['PROD_STOCK'] || row['stock'] || '0') || 0,
    active: row['PROD_ACTIVE'] !== '0' && row['PROD_ACTIVE']?.toLowerCase() !== 'false',
    images: row['PROD_IMAGE'] ? [row['PROD_IMAGE']] : [],
    tags: [],
    category_external_ids: parseCategoryIds(row['PROD_CAT_ID']),
    vendor: row['MANUFAC_ID'] || null,
    vat_rate: row['PROD_VAT'] ? parseFloat(row['PROD_VAT'].replace(',', '.')) : null,
    language: row['LANGUAGE_ID'] || 'da',
  }));
}

/**
 * Parse customers CSV from DanDomain
 */
export function parseCustomersCSV(csvText: string): (CustomerData & { external_id: string })[] {
  const rows = parseCSV(csvText);
  
  return rows.map(row => {
    const nameParts = (row['NAME'] || '').split(' ');
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';

    const address: Address = {
      address1: row['ADDRESS'] || '',
      address2: row['ADDRESS_2'] || null,
      city: row['CITY'] || '',
      zip: row['ZIP_CODE'] || '',
      country: row['COUNTRY'] || 'DK',
      phone: row['PHONE'] || null,
    };

    return {
      external_id: row['ID'] || '',
      email: row['EMAIL'] || '',
      first_name: firstName,
      last_name: lastName,
      company: row['COMPANY'] || null,
      phone: row['PHONE'] || null,
      country: row['COUNTRY'] || null,
      vat_number: row['VAT_NO'] || null,
      accepts_marketing: row['NEWSLETTER'] === '1' || row['NEWSLETTER']?.toLowerCase() === 'true',
      addresses: [address],
      created_at: parseDate(row['CREATED_DATE']),
    };
  });
}

/**
 * Parse orders CSV from DanDomain
 */
export function parseOrdersCSV(csvText: string): (OrderData & { external_id: string })[] {
  const rows = parseCSV(csvText);
  
  return rows.map(row => {
    const shippingAddress: Address = {
      address1: row['DELIVERY_ADDRESS'] || '',
      address2: null,
      city: row['DELIVERY_CITY'] || '',
      zip: row['DELIVERY_ZIP'] || '',
      country: row['DELIVERY_COUNTRY'] || 'DK',
      phone: null,
    };

    // For now, we don't have line items in the order CSV
    const lineItems: LineItem[] = [];

    return {
      external_id: row['ORDER_ID'] || '',
      customer_external_id: row['CUST_ID'] || '',
      order_date: parseDate(row['DATE']),
      currency: row['CURRENCY_CODE'] || 'DKK',
      subtotal_price: parsePrice(row['ORDER_TOTAL_PRICE']) - parsePrice(row['ORDER_VAT_AMOUNT']),
      total_price: parsePrice(row['ORDER_TOTAL_PRICE']),
      total_tax: parsePrice(row['ORDER_VAT_AMOUNT']),
      shipping_price: parsePrice(row['SHIPPING_PRICE']),
      discount_total: parsePrice(row['DISCOUNT_AMOUNT']),
      line_items: lineItems,
      billing_address: shippingAddress, // Use same as shipping for now
      shipping_address: shippingAddress,
      financial_status: 'paid', // Historical orders
      fulfillment_status: 'fulfilled', // Historical orders
    };
  });
}

/**
 * Parse categories CSV from DanDomain
 * Supports multiple field naming conventions
 */
export interface CategoryData {
  external_id: string;
  name: string;
  parent_external_id: string | null;
  slug: string | null;
}

// Helper to find a value from multiple possible field names (case-insensitive)
function getField(row: Record<string, string>, ...fieldNames: string[]): string {
  for (const fieldName of fieldNames) {
    // Try exact match first
    if (row[fieldName] !== undefined && row[fieldName] !== '') {
      return row[fieldName];
    }
    // Try case-insensitive match
    const lowerField = fieldName.toLowerCase();
    for (const key of Object.keys(row)) {
      if (key.toLowerCase() === lowerField && row[key] !== undefined && row[key] !== '') {
        return row[key];
      }
    }
  }
  return '';
}

export function parseCategoriesCSV(csvText: string): CategoryData[] {
  const rows = parseCSV(csvText);
  
  // Log available headers for debugging
  if (rows.length > 0) {
    console.log('Category CSV headers:', Object.keys(rows[0]));
    console.log('First 3 rows:', rows.slice(0, 3));
  } else {
    console.log('No rows parsed from category CSV');
    console.log('Raw CSV preview (first 500 chars):', csvText.substring(0, 500));
  }
  
  return rows
    .map(row => {
      // DanDomain PRODUCTCATEGORIES export typically uses these field names
      // Try multiple variations to be flexible
      const external_id = getField(row, 
        'PROD_CAT_ID',           // DanDomain primary
        'InternalId',            // Sometimes used
        'CAT_ID', 
        'ID', 
        'CATEGORY_ID', 
        'CategoryId', 
        'category_id', 
        'cat_id', 
        'id'
      );
      
      const name = getField(row, 
        'PROD_CAT_NAME',         // DanDomain primary
        'Name',                  // Common alternative
        'CAT_NAME', 
        'NAME', 
        'CATEGORY_NAME', 
        'TITLE',
        'CategoryName', 
        'category_name', 
        'cat_name', 
        'name', 
        'title'
      );
      
      const parent = getField(row,
        'PROD_CAT_PARENT',       // DanDomain variation
        'PARENT_CAT_ID', 
        'PARENT_ID', 
        'PARENT_CATEGORY_ID',
        'ParentCatId', 
        'parent_cat_id', 
        'parent_id'
      );
      
      const slug = getField(row,
        'PROD_CAT_UNIQUE_URL_NAME', 
        'UrlName',
        'CAT_SLUG', 
        'SLUG', 
        'URL', 
        'SEO_URL',
        'CategorySlug', 
        'category_slug', 
        'slug', 
        'url'
      );

      // Debug log for first few rows
      if (rows.indexOf(row) < 3) {
        console.log('Category row parsed:', { external_id, name, parent, slug });
      }
      
      return {
        external_id,
        name: name || external_id, // Use ID as name fallback
        parent_external_id: parent || null,
        slug: slug || null,
      };
    })
    .filter((cat) => cat.external_id && !cat.external_id.includes('#') && !cat.name.includes('#'));
}