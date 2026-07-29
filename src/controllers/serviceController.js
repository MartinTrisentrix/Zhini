import { withDatabase } from '../utils/config.js';
import { scrapeServiceCenters,scrapeHomeServices } from '../services/scrapeService.js';
import 'dotenv/config';
import {minioClient} from '../services/minioClient.js';

const mongoUri = process.env.MONGODB_URI;
const CACHE_EXPIRATION_MS = 24 * 60 * 60 * 1000; // 24 Hours in milliseconds

export const getNearbyService = async (c) => {
  try {
    const rawBrand = c.req.query('brand') || '';
    const rawProduct = c.req.query('product') || '';
    const rawPincode = c.req.query('pincode') || '';
    const isUnderWarranty = c.req.query('isUnderWarranty') === 'true' || c.req.query('inWarranty') === 'true';

    // Helper to sanitize inputs
    const cleanValue = (val) => {
      if (!val) return '';
      const sanitized = val.trim();
      const upper = sanitized.toUpperCase();
      if (upper === 'N/A' || upper === 'UNDEFINED' || upper === 'NULL') return '';
      return sanitized;
    };

    const brand = cleanValue(rawBrand);
    const product = cleanValue(rawProduct);
    const pincode = cleanValue(rawPincode);

    if (!pincode || (!brand && !product)) {
      console.warn(`⚠️ Validation Failed [400]: brand="${rawBrand}", product="${rawProduct}", pincode="${rawPincode}"`);
      return c.json({ 
        success: false, 
        message: 'pincode and at least one search term (brand or product) are required' 
      }, 400);
    }

    const response = await withDatabase(mongoUri, async (db) => {
      const cacheCollection = db.collection('service_cache');

      // -------------------------------------------------------------
      // TIER 1: ACTIVE WARRANTY -> Authorized Service Centers Only
      // -------------------------------------------------------------
      if (isUnderWarranty) {
        console.log(`🛡️ Tier 1 Triggered: Searching Authorized Centers for ${brand} ${product} in ${pincode}`);
        const cacheKey = `tier1_${brand}_${product}_${pincode}`.toLowerCase().replace(/\s+/g, '');

        const cached = await cacheCollection.findOne({ key: cacheKey });
        if (cached && (Date.now() - cached.timestamp) < CACHE_EXPIRATION_MS) {
          console.log(`💾 Cache Hit (Tier 1): ${cacheKey}`);
          return { tier: 1, tierName: 'Brand Authorized', data: cached.data };
        }

        const centers = await scrapeServiceCenters(brand, product, pincode, { authorizedOnly: true });
        
        if (centers.length > 0) {
          await cacheCollection.updateOne(
            { key: cacheKey },
            { $set: { key: cacheKey, data: centers, timestamp: Date.now() } },
            { upsert: true }
          );
        }

        return { tier: 1, tierName: 'Brand Authorized', data: centers };
      }

      // -------------------------------------------------------------
      // TIER 2: OUT OF WARRANTY -> Safely Check Neighbor Service History
      // -------------------------------------------------------------
      console.log(`🔍 Checking Tier 2: Neighbor service history for ${product} in ${pincode}`);
      let neighborHistory = [];

      try {
        const historyCollection = db.collection('service_history');

        // Safely attempt query (returns empty array if collection doesn't exist yet)
        neighborHistory = await historyCollection.aggregate([
          { 
            $match: { 
              pincode: pincode, 
              productCategory: { $regex: new RegExp(`^${product}$`, 'i') },
              status: 'COMPLETED'
            } 
          },
          {
            $group: {
              _id: "$serviceCenterId",
              name: { $first: "$serviceCenterName" },
              address: { $first: "$serviceCenterAddress" },
              phone: { $first: "$serviceCenterPhone" },
              rating: { $first: "$serviceCenterRating" },
              timesUsed: { $sum: 1 },
              lastServicedDate: { $max: "$completedAt" }
            }
          },
          { $sort: { timesUsed: -1, lastServicedDate: -1 } }
        ]).toArray();
      } catch (err) {
        // If collection doesn't exist or query fails, log soft warning and fallback to Tier 3
        console.warn(`⚠️ Tier 2 check skipped or collection unavailable: ${err.message}`);
        neighborHistory = [];
      }

      // If neighbor history is found, return Tier 2 results
      if (neighborHistory && neighborHistory.length > 0) {
        console.log(`🤝 Tier 2 Hit: Found ${neighborHistory.length} neighbor-recommended centers`);
        
        const tier2Data = neighborHistory.map(item => ({
          name: item.name,
          phone: item.phone || "N/A",
          address: item.address || "Address not available",
          rating: item.rating ? item.rating.toString() : "N/A",
          neighborProof: {
            timesUsed: item.timesUsed,
            badge: `Used by ${item.timesUsed} neighbor${item.timesUsed > 1 ? 's' : ''} near you`,
            lastUsed: item.lastServicedDate
          }
        }));

        return { tier: 2, tierName: 'Neighbor Trusted', data: tier2Data };
      }

      // -------------------------------------------------------------
      // TIER 3 (Fallback): OUT OF WARRANTY + NO HISTORY -> Top 5 General
      // -------------------------------------------------------------
      console.log(`🏢 Tier 3 Fallback Triggered: Fetching Top 5 local centers for ${brand || product} in ${pincode}`);
      const cacheKeyTier3 = `tier3_${brand}_${product}_${pincode}`.toLowerCase().replace(/\s+/g, '');

      const cachedTier3 = await cacheCollection.findOne({ key: cacheKeyTier3 });
      if (cachedTier3 && (Date.now() - cachedTier3.timestamp) < CACHE_EXPIRATION_MS) {
        console.log(`💾 Cache Hit (Tier 3): ${cacheKeyTier3}`);
        return { tier: 3, tierName: 'General Top Rated', data: cachedTier3.data };
      }

      const rawCenters = await scrapeServiceCenters(brand, product, pincode, { authorizedOnly: false });
      
      // Sort by rating (descending) and cap at Top 5
      const top5Centers = rawCenters
        .sort((a, b) => (parseFloat(b.rating) || 0) - (parseFloat(a.rating) || 0))
        .slice(0, 5);

      if (top5Centers.length > 0) {
        await cacheCollection.updateOne(
          { key: cacheKeyTier3 },
          { $set: { key: cacheKeyTier3, data: top5Centers, timestamp: Date.now() } },
          { upsert: true }
        );
      }

      return { tier: 3, tierName: 'General Top Rated', data: top5Centers };
    });

    return c.json({ 
      success: true, 
      tier: response.tier,
      tierName: response.tierName,
      count: response.data.length,
      data: response.data 
    }, 200);

  } catch (error) {
    console.error("❌ Service Controller Error:", error);
    return c.json({ success: false, message: "Internal Server Error", error: error.message }, 500);
  }
};

export const getNearbyHomeServices = async (c) => {
  try {
    const rawServiceType = c.req.query('serviceType') || c.req.query('category') || '';
    const rawPincode = c.req.query('pincode') || '';

    // Helper to sanitize query inputs
    const cleanValue = (val) => {
      if (!val) return '';
      const sanitized = val.trim();
      const upper = sanitized.toUpperCase();
      if (upper === 'N/A' || upper === 'UNDEFINED' || upper === 'NULL') return '';
      return sanitized;
    };

    const serviceType = cleanValue(rawServiceType);
    const pincode = cleanValue(rawPincode);

    // Validation: Need both pincode and serviceType (e.g., Electrician, Plumber)
    if (!pincode || !serviceType) {
      console.warn(`⚠️ Validation Failed [400]: serviceType="${rawServiceType}", pincode="${rawPincode}"`);
      return c.json({ 
        success: false, 
        message: 'Both serviceType (e.g. Electrician, Plumber) and pincode are required' 
      }, 400);
    }

    const cacheKey = `home_service_${serviceType}_${pincode}`.toLowerCase().replace(/\s+/g, '');

    const servicesData = await withDatabase(mongoUri, async (db) => {
      const collection = db.collection('common_cache');

      // 1. Check Cache
      const cached = await collection.findOne({ key: cacheKey });
      if (cached && (Date.now() - cached.timestamp) < CACHE_EXPIRATION_MS) {
        console.log(`💾 Cache Hit (Home Services): ${cacheKey}`);
        return cached.data;
      }

      // 2. Cache Miss -> Fetch live local technicians
      console.log(`🌐 Scraping live local services for "${serviceType}" in ${pincode}...`);
      const freshData = await scrapeHomeServices(serviceType, pincode);

      // Sort by highest rating & pick Top 5 local service providers
      const topServices = freshData
        .sort((a, b) => (parseFloat(b.rating) || 0) - (parseFloat(a.rating) || 0))
        .slice(0, 5);

      if (topServices.length > 0) {
        await collection.updateOne(
          { key: cacheKey },
          { $set: { key: cacheKey, data: topServices, timestamp: Date.now() } },
          { upsert: true }
        );
      }

      return topServices;
    });

    return c.json({ 
      success: true, 
      category: serviceType,
      count: servicesData.length,
      data: servicesData 
    }, 200);

  } catch (error) {
    console.error("❌ Home Services Controller Error:", error);
    return c.json({ success: false, message: "Internal Server Error", error: error.message }, 500);
  }
};


//Service Provider Part//

export const createServiceProvider = async (c) => {
  try {
    const body = await c.req.parseBody();

    // 1. Extract and validate mandatory fields
    const name = body["name"];
    const mobile = body["mobile"];
    const range = body["range"];
    const expertiseInput = body["expertise"];
    const gstNumber = body["gstNumber"] || null; // Optional

    if (!name || !mobile || !range || !expertiseInput) {
      return c.json({
        success: false,
        message: "Missing required fields: name, mobile, range, or expertise."
      }, 400);
    }

    // 2. Format expertise (handles comma-separated string or array)
    let expertise = [];
    if (typeof expertiseInput === "string") {
      expertise = expertiseInput.split(",").map((e) => e.trim()).filter(Boolean);
    } else if (Array.isArray(expertiseInput)) {
      expertise = expertiseInput.map((e) => String(e).trim());
    }

    // 3. Handle optional shop photo upload to MinIO
    let shopImageUrl = null;
    const photoFile = body["photo"]; // Form-data field name: 'photo'

    if (photoFile && photoFile instanceof File) {
      const fileExtension = photoFile.name.split(".").pop() || "jpg";
      const fileName = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}.${fileExtension}`;

      const arrayBuffer = await photoFile.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      await minioClient.putObject(
        "app-images",
        fileName,
        buffer,
        buffer.length,
        { "Content-Type": photoFile.type || "image/jpeg" }
      );

      const baseUrl = process.env.MINIO_PUBLIC_URL || "http://192.168.0.7:9000";
      shopImageUrl = `${baseUrl}/app-images/${fileName}`;
    }

    // 4. Construct document payload
    const newProvider = {
      name: name.trim(),
      mobile: mobile.trim(),
      expertise,
      serviceRadiusKm: Number(range) || range,
      gstNumber: gstNumber ? gstNumber.trim() : null,
      shopImageUrl,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // 5. Query database using withDatabase wrapper
    const result = await withDatabase(mongoUri, async (db) => {
      const collection = db.collection("Service-Providers");
      return await collection.insertOne(newProvider);
    });

    // 6. Return success response
    return c.json({
      success: true,
      message: "Service Provider created successfully.",
      data: {
        _id: result.insertedId,
        ...newProvider
      }
    }, 201);

  } catch (error) {
    console.error("❌ Create Service Provider Controller Error:", error);
    return c.json({
      success: false,
      message: "Internal Server Error",
      error: error.message
    }, 500);
  }
};


export const getAllServiceProviders = async (c) => {
  try {
    // 1. Query database using withDatabase wrapper
    const providers = await withDatabase(mongoUri, async (db) => {
      const collection = db.collection("Service-Providers");
      return await collection.find({}).sort({ createdAt: -1 }).toArray();
    });

    // 2. Handle case where no providers exist
    if (!providers || providers.length === 0) {
      return c.json({
        success: true,
        message: "No service providers found.",
        count: 0,
        data: []
      }, 200);
    }

    // 3. Return success response
    return c.json({
      success: true,
      message: `Successfully retrieved ${providers.length} service provider(s).`,
      count: providers.length,
      data: providers
    }, 200);

  } catch (error) {
    console.error("❌ Get All Service Providers Controller Error:", error);
    return c.json({
      success: false,
      message: "Internal Server Error",
      error: error.message
    }, 500);
  }
};


