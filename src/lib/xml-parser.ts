import { ProductData, CustomerData, OrderData, Address, LineItem } from '@/types/database';

/**
 * XML Parser for DanDomain exports
 * Handles PRODUCTS, PRODUCTCATEGORIES, ORDERS XML exports
 */

/**
 * Parse DanDomain price format (comma as decimal separator)
 */
function parsePrice(priceStr: string): number {
  if (!priceStr) return 0;
  // Handle Danish format: "220,00" -> 220.00
  const normalized = priceStr.replace(',', '.').replace(/[^\d.-]/g, '');
  const result = parseFloat(normalized) || 0;
  if (priceStr && result === 0 && priceStr !== '0' && priceStr !== '0,00') {
    console.warn('Price parse warning:', priceStr, '->', normalized, '->', result);
  }
  return result;
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
 * Parse boolean from XML string (False/True, 0/1)
 */
function parseBoolean(value: string): boolean {
  if (!value) return false;
  const lower = value.toLowerCase().trim();
  return lower === 'true' || lower === '1';
}

/**
 * Get text content of an XML element by tag name
 */
function getElementText(element: Element, tagName: string): string {
  const el = element.getElementsByTagName(tagName)[0];
  return el?.textContent?.trim() || '';
}

/**
 * Sanitize XML text by removing invalid XML character references (e.g. &#8;)
 * XML 1.0 only allows: #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD]
 */
function sanitizeXml(xml: string): string {
  return xml.replace(/&#(?:(\d+)|x([0-9a-fA-F]+));/g, (match, dec, hex) => {
    const code = dec ? parseInt(dec, 10) : parseInt(hex!, 16);
    if (code === 0x9 || code === 0xA || code === 0xD) return match;
    if (code >= 0x20) return match;
    return '';
  });
}

/**
 * Get all elements with a specific tag name as an array
 */
function getAllElements(element: Element, tagName: string): Element[] {
  return Array.from(element.getElementsByTagName(tagName));
}

/**
 * Parse products XML from DanDomain
 * Structure: PRODUCT_EXPORT > ELEMENTS > PRODUCT
 */
export function parseProductsXML(xmlText: string): ProductData[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(sanitizeXml(xmlText), 'text/xml');
  
  // Check for parse errors
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    console.error('XML parse error:', parseError.textContent);
    return [];
  }
  
  const products = getAllElements(doc.documentElement, 'PRODUCT');
  console.log(`Parsing ${products.length} products from XML`);
  
  return products
    .map(product => {
      // GENERAL section
      const general = product.getElementsByTagName('GENERAL')[0];
      const sku = general ? getElementText(general, 'PROD_NUM') : '';
      const title = general ? getElementText(general, 'PROD_NAME') : '';
      const weight = general ? parseFloat(getElementText(general, 'PROD_WEIGHT').replace(',', '.')) || null : null;
      const mainImage = general ? getElementText(general, 'PROD_PHOTO_URL') : '';
      const costPrice = general ? parsePrice(getElementText(general, 'PROD_COST_PRICE')) : null;
      
      // ADVANCED section
      const advanced = product.getElementsByTagName('ADVANCED')[0];
      const hidden = advanced ? parseBoolean(getElementText(advanced, 'PROD_HIDDEN')) : false;
      const barcode = advanced ? getElementText(advanced, 'PROD_BARCODE_NUMBER') : '';
      const internalId = advanced ? getElementText(advanced, 'INTERNAL_ID') : '';
      
      // Period pricing (Periodestyring) - support both legacy and current DanDomain field names
      let periodId = getElementText(product, 'PRICE_PERIOD_ID') ||
                     getElementText(product, 'PROD_NEW_PERIOD_ID') || 
                     (advanced ? getElementText(advanced, 'PRICE_PERIOD_ID') : '') ||
                     (advanced ? getElementText(advanced, 'PROD_NEW_PERIOD_ID') : '') ||
                     '';
      
      // CUSTOM_FIELDS section - custom fields FIELD_1 to FIELD_20
      const customFieldsSection = product.getElementsByTagName('CUSTOM_FIELDS')[0];
      // Some DanDomain exports may not nest these under <CUSTOM_FIELDS>. Be defensive and fall back
      // to searching within the full <PRODUCT> element.
      const field1 = (customFieldsSection ? getElementText(customFieldsSection, 'FIELD_1') : '') || getElementText(product, 'FIELD_1');
      const field2 = (customFieldsSection ? getElementText(customFieldsSection, 'FIELD_2') : '') || getElementText(product, 'FIELD_2');
      const field3 = (customFieldsSection ? getElementText(customFieldsSection, 'FIELD_3') : '') || getElementText(product, 'FIELD_3');
      const field9 = (customFieldsSection ? getElementText(customFieldsSection, 'FIELD_9') : '') || getElementText(product, 'FIELD_9');
      
      // STOCK section
      const stock = product.getElementsByTagName('STOCK')[0];
      const stockCount = stock ? parseInt(getElementText(stock, 'STOCK_COUNT')) || 0 : 0;
      
      // DESCRIPTION section
      const description = product.getElementsByTagName('DESCRIPTION')[0];
      const bodyHtml = description ? getElementText(description, 'DESC_LONG') : '';
      const shortDescription = description ? getElementText(description, 'DESC_SHORT') : '';
      const metaDescription = description ? getElementText(description, 'META_DESCRIPTION') : '';
      
      // SEO section - meta title is sometimes in SEO section or uses PROD_NAME as fallback
      const seoSection = product.getElementsByTagName('SEO')[0];
      const metaTitle = seoSection ? getElementText(seoSection, 'META_TITLE') : '';
      
      // PRICES section - get first/default price
      const prices = product.getElementsByTagName('PRICES')[0];
      let price = 0;
      let specialOfferPrice: number | null = null;
      if (prices) {
        const priceElements = getAllElements(prices, 'PRICE');
        if (priceElements.length > 0) {
          const firstPrice = priceElements[0];
          price = parsePrice(getElementText(firstPrice, 'UNIT_PRICE'));
          const specialOffer = parsePrice(getElementText(firstPrice, 'SPECIAL_OFFER_PRICE'));
          if (!periodId) {
            periodId = getElementText(firstPrice, 'PRICE_PERIOD_ID') ||
                       getElementText(firstPrice, 'PROD_NEW_PERIOD_ID') ||
                       '';
          }
          if (specialOffer > 0) {
            specialOfferPrice = specialOffer;
          }
        }
      }
      
      // MANUFACTURERS section – extract MANUFAC_ID only.
      // The product XML never contains MANUFAC_NAME; that comes from the separate
      // manufacturers export file and is resolved at upload time via canonical_manufacturers.
      const manufacturers = product.getElementsByTagName('MANUFACTURERS')[0];
      const vendor = manufacturers
        ? getElementText(manufacturers, 'MANUFAC_ID')
        : null;
      
      // PRODUCT_CATEGORIES section
      const categoriesSection = product.getElementsByTagName('PRODUCT_CATEGORIES')[0];
      const categoryIds: string[] = [];
      if (categoriesSection) {
        const catIdElements = getAllElements(categoriesSection, 'PROD_CAT_ID');
        catIdElements.forEach(el => {
          const catId = el.textContent?.trim();
          if (catId) categoryIds.push(catId);
        });
      }
      
      // PRODUCT_MEDIA section - additional images
      const images: string[] = [];
      if (mainImage) images.push(mainImage);
      
      const mediaSection = product.getElementsByTagName('PRODUCT_MEDIA')[0];
      if (mediaSection) {
        const mediaElements = getAllElements(mediaSection, 'MEDIA');
        mediaElements.forEach(media => {
          const mediaUrl = getElementText(media, 'MEDIA_URL');
          if (mediaUrl && !images.includes(mediaUrl)) {
            images.push(mediaUrl);
          }
        });
      }
      
      // Build DanDomain source path from title and SKU
      // Pattern: /shop/{slugified-title}-{sku}p.html
      const slugifiedTitle = title
        .toLowerCase()
        .replace(/[æ]/g, 'ae')
        .replace(/[ø]/g, 'oe')
        .replace(/[å]/g, 'aa')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      const sourcePath = sku ? `/shop/${slugifiedTitle}-${sku}p.html` : null;
      
      return {
        title,
        body_html: bodyHtml,
        short_description: shortDescription,
        sku,
        price,
        compare_at_price: null,
        special_offer_price: specialOfferPrice,
        cost_price: costPrice,
        weight,
        stock_quantity: stockCount,
        active: !hidden,
        images,
        tags: [],
        category_external_ids: categoryIds,
        vendor,
        vat_rate: null,
        language: 'da',
        // Additional XML-specific fields stored in data
        barcode,
        internal_id: internalId,
        // Custom fields for metafield mapping
        field_1: field1,
        field_2: field2,
        field_3: field3,
        field_9: field9,
        // SEO fields
        meta_title: metaTitle,
        meta_description: metaDescription,
        // DanDomain source path for redirects
        source_path: sourcePath,
        // Period pricing
        period_id: periodId || undefined,
      };
    })
    .filter(product => {
      const hasTitle = product.title && product.title.trim() !== '';
      const hasSku = product.sku && product.sku.trim() !== '';
      
      if (!hasTitle && !hasSku) {
        console.log('Skipping empty product - no title or SKU');
        return false;
      }
      
      if (!hasTitle && hasSku) {
        console.warn(`Product with SKU "${product.sku}" has no title - will be skipped`);
        return false;
      }
      
      return true;
    });
}

/**
 * Period data interface for XML parsing (Periodestyring)
 */
export interface PeriodData {
  period_id: string;
  title: string | null;
  start_date: string | null; // ISO date string (YYYY-MM-DD)
  end_date: string | null;   // ISO date string (YYYY-MM-DD)
  disabled: boolean;
}

/**
 * Parse periods XML from DanDomain (Periodestyring)
 * Structure: PERIOD_EXPORT > ELEMENTS > PERIOD (or similar)
 * Fields: ID, TITLE, START_DATE (dd-mm-yyyy), END_DATE (dd-mm-yyyy), DISABLED
 */
export function parsePeriodsXML(xmlText: string): PeriodData[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(sanitizeXml(xmlText), 'text/xml');
  
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    console.error('XML parse error:', parseError.textContent);
    return [];
  }
  
  // Try different possible root element names
  let periods = getAllElements(doc.documentElement, 'PERIOD');
  if (periods.length === 0) {
    periods = getAllElements(doc.documentElement, 'ROW');
  }
  if (periods.length === 0) {
    // Fallback: try direct children of ELEMENTS
    const elements = doc.documentElement.getElementsByTagName('ELEMENTS')[0];
    if (elements) {
      periods = Array.from(elements.children);
    }
  }
  
  console.log(`Parsing ${periods.length} periods from XML`);
  
  return periods
    .map(period => {
      const periodId = getElementText(period, 'ID');
      const title = getElementText(period, 'TITLE') || null;
      const startDateStr = getElementText(period, 'START_DATE');
      const endDateStr = getElementText(period, 'END_DATE');
      const disabled = parseBoolean(getElementText(period, 'DISABLED'));
      
      // Parse dd-mm-yyyy to YYYY-MM-DD
      const parseShortDate = (s: string): string | null => {
        if (!s) return null;
        const match = s.match(/(\d{2})-(\d{2})-(\d{4})/);
        if (!match) return null;
        return `${match[3]}-${match[2]}-${match[1]}`;
      };
      
      return {
        period_id: periodId,
        title,
        start_date: parseShortDate(startDateStr),
        end_date: parseShortDate(endDateStr),
        disabled,
      };
    })
    .filter(p => p.period_id);
}

/**
 * Manufacturer data interface for XML parsing
 */
export interface ManufacturerData {
  external_id: string;
  name: string;
}

/**
 * Parse manufacturers XML from DanDomain
 * Structure: MANUFACTURER_EXPORT > ELEMENTS > MANUFACTURER (or similar)
 * Fields: MANUFAC_ID, MANUFAC_NAME (or ID, NAME)
 */
export function parseManufacturersXML(xmlText: string): ManufacturerData[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(sanitizeXml(xmlText), 'text/xml');
  
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    console.error('XML parse error:', parseError.textContent);
    return [];
  }

  // Try different possible container element names
  let manufacturers = getAllElements(doc.documentElement, 'MANUFACTURER');
  if (manufacturers.length === 0) {
    manufacturers = getAllElements(doc.documentElement, 'ROW');
  }
  if (manufacturers.length === 0) {
    const elements = doc.documentElement.getElementsByTagName('ELEMENTS')[0];
    if (elements) {
      manufacturers = Array.from(elements.children) as Element[];
    }
  }

  console.log(`Parsing ${manufacturers.length} manufacturers from XML`);

  const getDirectChildText = (parent: Element, tagNames: string[]): string => {
    const children = Array.from(parent.children) as Element[];

    // First pass: exact case-sensitive match
    for (const tagName of tagNames) {
      const exact = children.find((child) => child.tagName === tagName);
      const text = exact?.textContent?.trim() || '';
      if (text) return text;
    }

    // Second pass: case-insensitive fallback to handle export variants safely
    for (const tagName of tagNames) {
      const lower = tagName.toLowerCase();
      const ci = children.find((child) => child.tagName.toLowerCase() === lower);
      const text = ci?.textContent?.trim() || '';
      if (text) return text;
    }

    return '';
  };

  const byExternalId = new Map<string, ManufacturerData>();

  for (const mfr of manufacturers) {
    const externalId = getDirectChildText(mfr, ['MANUFAC_ID', 'ID']);
    if (!externalId) continue;

    const rawName = getDirectChildText(mfr, ['MANUFAC_NAME', 'NAME', 'TITLE']);
    const name = rawName || externalId; // Required fallback when MANUFAC_NAME is empty

    const existing = byExternalId.get(externalId);
    if (!existing || existing.name === existing.external_id) {
      byExternalId.set(externalId, { external_id: externalId, name });
    }
  }

  return Array.from(byExternalId.values());
}

/**
 * Category data interface for XML parsing
 */
export interface CategoryData {
  external_id: string;
  name: string;
  parent_external_id: string | null;
  slug: string | null;
  description?: string;
  hidden?: boolean;
}

/**
 * Parse categories XML from DanDomain
 * Structure: PRODUCT_CATEGORY_EXPORT > ELEMENTS > PRODUCT_CATEGORY
 */
export function parseCategoriesXML(xmlText: string): CategoryData[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(sanitizeXml(xmlText), 'text/xml');
  
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    console.error('XML parse error:', parseError.textContent);
    return [];
  }
  
  const categories = getAllElements(doc.documentElement, 'PRODUCT_CATEGORY');
  console.log(`Parsing ${categories.length} categories from XML`);
  
  return categories
    .map(category => {
      const externalId = getElementText(category, 'PROD_CAT_ID');
      const name = getElementText(category, 'PROD_CAT_NAME');
      const hidden = parseBoolean(getElementText(category, 'PROD_CAT_HIDDEN'));
      const slug = getElementText(category, 'PROD_CAT_UNIQUE_URL_NAME') || null;
      const description = getElementText(category, 'PROD_CAT_DESCRIPTION');
      
      // Parent category - in PARENT_CATEGORIES > PARENT_CAT_ID
      const parentSection = category.getElementsByTagName('PARENT_CATEGORIES')[0];
      let parentId: string | null = null;
      if (parentSection) {
        const parentCatId = getElementText(parentSection, 'PARENT_CAT_ID');
        // 0 means root/no parent
        if (parentCatId && parentCatId !== '0') {
          parentId = parentCatId;
        }
      }
      
      // Build DanDomain source path for category
      // Pattern: /shop/{category-slug}-{id}c1.html or just /shop/{slug}/
      const sourcePath = slug ? `/shop/${slug}/` : null;
      
      return {
        external_id: externalId,
        name: name || externalId,
        parent_external_id: parentId,
        slug,
        description,
        hidden,
        source_path: sourcePath,
      };
    })
    .filter(cat => cat.external_id);
}

/**
 * Parse orders XML from DanDomain
 * Structure: ORDER_EXPORT > ELEMENTS > ORDER
 */
export function parseOrdersXML(xmlText: string): (OrderData & { external_id: string })[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(sanitizeXml(xmlText), 'text/xml');
  
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    console.error('XML parse error:', parseError.textContent);
    return [];
  }
  
  const orders = getAllElements(doc.documentElement, 'ORDER');
  console.log(`Parsing ${orders.length} orders from XML`);
  
  return orders.map(order => {
    // GENERAL section
    const general = order.getElementsByTagName('GENERAL')[0];
    const orderId = general ? getElementText(general, 'ORDER_ID') : '';
    const orderDate = general ? parseDate(getElementText(general, 'DATE')) : new Date().toISOString();
    const currency = general ? getElementText(general, 'CURRENCY_CODE') || 'DKK' : 'DKK';
    const totalPrice = general ? parsePrice(getElementText(general, 'ORDER_TOTAL_PRICE')) : 0;
    const vatPercent = general ? parseFloat(getElementText(general, 'ORDER_VAT')) || 25 : 25;
    
    // ADVANCED section
    const advanced = order.getElementsByTagName('ADVANCED')[0];
    const discount = advanced ? parsePrice(getElementText(advanced, 'DISCOUNT')) : 0;
    
    // SHIPPING_METHOD section
    const shippingMethod = order.getElementsByTagName('SHIPPING_METHOD')[0];
    const shippingPrice = shippingMethod ? parsePrice(getElementText(shippingMethod, 'SHIP_METHOD_FEE')) : 0;
    
    // CUSTOMER section
    const customerSection = order.getElementsByTagName('CUSTOMER')[0];
    let customerExternalId = '';
    let customerEmail = '';
    let customerFirstName = '';
    let customerLastName = '';
    let customerPhone = '';
    let customerAddress = '';
    let customerZip = '';
    let customerCity = '';
    let customerCountry = 'DK';
    
    if (customerSection) {
      customerExternalId = getElementText(customerSection, 'CUST_NUM');
      customerEmail = getElementText(customerSection, 'CUST_EMAIL');
      const fullName = getElementText(customerSection, 'CUST_NAME');
      const nameParts = fullName.split(' ');
      customerFirstName = nameParts[0] || '';
      customerLastName = nameParts.slice(1).join(' ') || '';
      customerPhone = getElementText(customerSection, 'CUST_PHONE');
      customerAddress = getElementText(customerSection, 'CUST_ADDRESS');
      customerZip = getElementText(customerSection, 'CUST_ZIP_CODE');
      customerCity = getElementText(customerSection, 'CUST_CITY');
      customerCountry = getElementText(customerSection, 'CUST_COUNTRY_ISO') || 'DK';
    }
    
    // DELIVERY_INFO section
    const deliverySection = order.getElementsByTagName('DELIVERY_INFO')[0];
    let deliveryAddress: Address = {
      address1: customerAddress,
      address2: null,
      city: customerCity,
      zip: customerZip,
      country: customerCountry,
      phone: customerPhone,
    };
    
    if (deliverySection) {
      const delivName = getElementText(deliverySection, 'DELIV_NAME');
      const delivAddress = getElementText(deliverySection, 'DELIV_ADDRESS');
      const delivCity = getElementText(deliverySection, 'DELIV_CITY');
      const delivZip = getElementText(deliverySection, 'DELIV_ZIP_CODE');
      const delivCountry = getElementText(deliverySection, 'DELIV_COUNTRY_ISO') || getElementText(deliverySection, 'DELIV_COUNTRY');
      
      // Only use delivery info if it has actual content
      if (delivAddress || delivName) {
        deliveryAddress = {
          address1: delivAddress || customerAddress,
          address2: getElementText(deliverySection, 'DELIV_ADDRESS_2') || null,
          city: delivCity || customerCity,
          zip: delivZip || customerZip,
          country: delivCountry || customerCountry,
          phone: getElementText(deliverySection, 'DELIV_PHONE') || customerPhone,
        };
      }
    }
    
    // ORDERLINES section - actual line items!
    const orderlinesSection = order.getElementsByTagName('ORDERLINES')[0];
    const lineItems: LineItem[] = [];
    
    if (orderlinesSection) {
      const orderlineElements = getAllElements(orderlinesSection, 'ORDERLINE');
      orderlineElements.forEach(line => {
        const prodNum = getElementText(line, 'PROD_NUM');
        const prodName = getElementText(line, 'PROD_NAME');
        const quantity = parseInt(getElementText(line, 'AMOUNT')) || 1;
        const unitPrice = parsePrice(getElementText(line, 'UNIT_PRICE'));
        
        lineItems.push({
          product_external_id: prodNum,
          sku: prodNum,
          title: prodName,
          quantity,
          price: unitPrice,
        });
      });
    }
    
    // Fallback line item if no orderlines
    if (lineItems.length === 0 && totalPrice > 0) {
      lineItems.push({
        product_external_id: '',
        title: 'Ordre total',
        sku: `ORDER-${orderId}`,
        quantity: 1,
        price: totalPrice,
      });
    }
    
    // Calculate tax from VAT percentage
    const totalTax = totalPrice * (vatPercent / (100 + vatPercent));
    const subtotalPrice = totalPrice - totalTax;
    
    return {
      external_id: orderId,
      customer_external_id: customerExternalId,
      customer_email: customerEmail || undefined,
      customer_first_name: customerFirstName || undefined,
      customer_last_name: customerLastName || undefined,
      customer_phone: customerPhone || undefined,
      customer_address: customerAddress || undefined,
      customer_zip: customerZip || undefined,
      customer_city: customerCity || undefined,
      customer_country: customerCountry || undefined,
      order_date: orderDate,
      currency,
      subtotal_price: subtotalPrice,
      total_price: totalPrice,
      total_tax: totalTax,
      shipping_price: shippingPrice,
      discount_total: discount,
      line_items: lineItems,
      billing_address: deliveryAddress,
      shipping_address: deliveryAddress,
      financial_status: 'paid',
      fulfillment_status: 'fulfilled',
    };
  });
}

/**
 * Parse customers from orders XML
 * DanDomain doesn't have separate customer export in XML - extract from orders
 */
export function parseCustomersFromOrdersXML(xmlText: string): (CustomerData & { external_id: string })[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(sanitizeXml(xmlText), 'text/xml');
  
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    console.error('XML parse error:', parseError.textContent);
    return [];
  }
  
  const orders = getAllElements(doc.documentElement, 'ORDER');
  const customerMap = new Map<string, CustomerData & { external_id: string }>();
  
  orders.forEach(order => {
    const customerSection = order.getElementsByTagName('CUSTOMER')[0];
    if (!customerSection) return;
    
    const custNum = getElementText(customerSection, 'CUST_NUM');
    const email = getElementText(customerSection, 'CUST_EMAIL');
    
    // Use email or customer number as key
    const key = email || custNum;
    if (!key || customerMap.has(key)) return;
    
    const fullName = getElementText(customerSection, 'CUST_NAME');
    const nameParts = fullName.split(' ');
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';
    
    // Try multiple phone fields - DanDomain may store phone in different locations
    const custPhone = getElementText(customerSection, 'CUST_PHONE') 
      || getElementText(customerSection, 'PHONE')
      || getElementText(customerSection, 'CUST_MOBILE')
      || getElementText(customerSection, 'MOBILE');
    
    const address: Address = {
      address1: getElementText(customerSection, 'CUST_ADDRESS'),
      address2: getElementText(customerSection, 'CUST_ADDRESS_2') || null,
      city: getElementText(customerSection, 'CUST_CITY'),
      zip: getElementText(customerSection, 'CUST_ZIP_CODE'),
      country: getElementText(customerSection, 'CUST_COUNTRY_ISO') || 'DK',
      phone: custPhone || null,
    };
    
    // Use customer phone, fallback to address phone if empty
    const finalPhone = custPhone || address.phone;
    
    customerMap.set(key, {
      external_id: custNum || email,
      email,
      first_name: firstName,
      last_name: lastName,
      company: getElementText(customerSection, 'CUST_COMPANY') || null,
      phone: finalPhone || null,
      country: getElementText(customerSection, 'CUST_COUNTRY_ISO') || null,
      vat_number: getElementText(customerSection, 'VAT_REG_NUM') || null,
      accepts_marketing: false,
      addresses: [address],
      created_at: new Date().toISOString(),
    });
  });
  
  console.log(`Extracted ${customerMap.size} unique customers from orders XML`);
  return Array.from(customerMap.values());
}

/**
 * Standalone customer XML parser (if DanDomain provides it)
 * Falls back to order-based extraction
 */
export function parseCustomersXML(xmlText: string): (CustomerData & { external_id: string })[] {
  // Check if this is an orders export (extract customers from it)
  if (xmlText.includes('<ORDER_EXPORT') || xmlText.includes('<ORDER>')) {
    return parseCustomersFromOrdersXML(xmlText);
  }
  
  // Otherwise try to parse as customer export
  const parser = new DOMParser();
  const doc = parser.parseFromString(sanitizeXml(xmlText), 'text/xml');
  
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    console.error('XML parse error:', parseError.textContent);
    return [];
  }
  
  // Try to find customer elements
  const customers = getAllElements(doc.documentElement, 'CUSTOMER');
  console.log(`Parsing ${customers.length} customers from XML`);
  
  return customers.map(customer => {
    const id = getElementText(customer, 'CUST_NUM') || getElementText(customer, 'ID');
    const email = getElementText(customer, 'CUST_EMAIL') || getElementText(customer, 'EMAIL');
    const fullName = getElementText(customer, 'CUST_NAME') || getElementText(customer, 'NAME');
    const nameParts = fullName.split(' ');
    
    // Try multiple phone fields - DanDomain may store phone in different locations
    const custPhone = getElementText(customer, 'CUST_PHONE') 
      || getElementText(customer, 'PHONE')
      || getElementText(customer, 'CUST_MOBILE')
      || getElementText(customer, 'MOBILE');
    
    const address: Address = {
      address1: getElementText(customer, 'CUST_ADDRESS') || getElementText(customer, 'ADDRESS'),
      address2: null,
      city: getElementText(customer, 'CUST_CITY') || getElementText(customer, 'CITY'),
      zip: getElementText(customer, 'CUST_ZIP_CODE') || getElementText(customer, 'ZIP_CODE'),
      country: getElementText(customer, 'CUST_COUNTRY_ISO') || getElementText(customer, 'COUNTRY') || 'DK',
      phone: custPhone || null,
    };
    
    // Use customer phone, fallback to address phone if empty
    const finalPhone = custPhone || address.phone;
    
    return {
      external_id: id || email,
      email,
      first_name: nameParts[0] || '',
      last_name: nameParts.slice(1).join(' ') || '',
      company: getElementText(customer, 'CUST_COMPANY') || null,
      phone: finalPhone || null,
      country: getElementText(customer, 'CUST_COUNTRY_ISO') || null,
      vat_number: getElementText(customer, 'VAT_REG_NUM') || null,
      accepts_marketing: false,
      addresses: [address],
      created_at: new Date().toISOString(),
    };
  });
}
