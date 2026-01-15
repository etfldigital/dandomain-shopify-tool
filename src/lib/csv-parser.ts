import { ProductData, CustomerData, OrderData, Address, LineItem } from '@/types/database';

/**
 * Parse semicolon-separated CSV (DanDomain format)
 */
function parseCSV(csvText: string): Record<string, string>[] {
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return [];

  // Parse header
  const headers = lines[0].split(';').map(h => h.trim().replace(/"/g, ''));
  
  // Parse rows
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(';').map(v => v.trim().replace(/"/g, ''));
    const row: Record<string, string> = {};
    
    headers.forEach((header, index) => {
      row[header] = values[index] || '';
    });
    
    rows.push(row);
  }

  return rows;
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
    category_external_ids: row['PROD_CAT_ID'] ? [row['PROD_CAT_ID']] : [],
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