import { withDatabase } from '../utils/config.js';
import { scrapeServiceCenters } from '../services/scrapeService.js';
import 'dotenv/config';

const mongoUri = process.env.MONGODB_URI;
const CACHE_EXPIRATION_MS = 24 * 60 * 60 * 1000; // 24 Hours in milliseconds

export const getNearbyService = async (c) => {
  try {
    const rawBrand = c.req.query('brand') || '';
    const rawProduct = c.req.query('product') || '';
    const rawPincode = c.req.query('pincode') || '';

    // Helper to check if a value is effectively empty or dummy data
    const cleanValue = (val) => {
      if (!val) return '';
      const sanitized = val.trim();
      const upper = sanitized.toUpperCase();
      if (upper === 'N/A' || upper === 'UNDEFINED' || upper === 'NULL') {
        return '';
      }
      return sanitized;
    };

    const brand = cleanValue(rawBrand);
    const product = cleanValue(rawProduct);
    const pincode = cleanValue(rawPincode);

    // Make sure we have a valid pincode AND at least one valid search term
    if (!pincode || (!brand && !product)) {
      console.warn(`⚠️ Validation Failed [400]: brand="${rawBrand}", product="${rawProduct}", pincode="${rawPincode}"`);
      return c.json({ 
        success: false, 
        message: 'pincode and at least one search term (brand or product) are required' 
      }, 400);
    }

    // Create dynamic cache key (e.g., "lg_tv_600043" or "laptop_600043")
    const dynamicKey = [brand, product].filter(Boolean).join('_').toLowerCase().replace(/\s+/g, '');
    const cacheKey = `${dynamicKey}_${pincode}`;

    const centersData = await withDatabase(mongoUri, async (db) => {
      const collection = db.collection('service_cache');
      
      // 1. Look for existing cache entry
      const cached = await collection.findOne({ key: cacheKey });
      
      if (cached) {
        const isExpired = (Date.now() - cached.timestamp) >= CACHE_EXPIRATION_MS;

        if (isExpired) {
          console.log(`🗑️ Cache Expired: Deleting old records for key: ${cacheKey}`);
          await collection.deleteOne({ key: cacheKey });
        } else {
          console.log(`💾 Cache Hit: Serving fresh centers from MongoDB for key: ${cacheKey}`);
          return cached.data;
        }
      }

      // 2. Cache Missed or Just Deleted - Run live scraper
      console.log(`🌐 Cache Miss: Scraping live data for "${[brand, product].filter(Boolean).join(' ')}" in ${pincode}...`);
      const freshData = await scrapeServiceCenters(brand, product, pincode);

      if (freshData && freshData.length > 0) {
        await collection.updateOne(
          { key: cacheKey },
          { $set: { key: cacheKey, data: freshData, timestamp: Date.now() } },
          { upsert: true }
        );
      }

      return freshData || [];
    });

    return c.json({ 
      success: true, 
      count: centersData.length,
      data: centersData 
    }, 200);

  } catch (error) {
    console.error("❌ Service Controller Error:", error);
    return c.json({ success: false, message: "Internal Server Error", error: error.message }, 500);
  }
};