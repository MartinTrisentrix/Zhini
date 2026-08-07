import { withDatabase } from '../utils/config.js';
import { scrapeServiceCenters, scrapeHomeServices } from '../services/scrapeService.js';
import 'dotenv/config';
import { minioClient } from '../services/minioClient.js';
import { createServiceCard, moveCardToList, createProviderBoard } from '../services/wekan.js';

const mongoUri = process.env.MONGODB_URI;
const CACHE_EXPIRATION_MS = 24 * 60 * 60 * 1000; // 24 Hours in milliseconds




export const getNearbyService = async (c) => {
  try {
    // 1. Read request body (for JSON payloads) with fallback to query params
    let body = {};
    try {
      body = await c.req.json();
    } catch (_) {
      // Body was empty or not JSON; fall back to query params
    }

    const rawBrand = body.brand || c.req.query('brand') || '';
    const rawProduct = body.product || c.req.query('product') || '';
    const rawPincode = body.pincode || c.req.query('pincode') || '';

    const isUnderWarranty = body.isUnderWarranty === true ||
      body.inWarranty === true ||
      c.req.query('isUnderWarranty') === 'true' ||
      c.req.query('inWarranty') === 'true';

    // Helper to sanitize inputs
    const cleanValue = (val) => {
      if (!val) return '';
      const sanitized = String(val).trim();
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
      // TIER 2: OUT OF WARRANTY -> Local Zhini Service Providers (By Pincode)
      // -------------------------------------------------------------
      console.log(`🔍 Checking Tier 2: Zhini Local Providers in pincode="${pincode}"`);

      try {
        // Updated collection name to match createServiceProvider ("Service-Providers")
        const providerCollection = db.collection('Service-Providers');

        // Match active providers strictly by pincode
        const matchingProviders = await providerCollection.find({
          pincode: pincode,
          status: 'active'
        }).toArray();

        if (matchingProviders.length > 0) {
          console.log(`🎯 Tier 2 Hit: Found ${matchingProviders.length} Zhini Service Provider(s) for pincode=${pincode}`);

          // Map provider details exactly as structured in the database document
          const providerList = matchingProviders.map(provider => ({
            id: provider._id,
            name: provider.name,
            mobile: provider.mobile,
            address: provider.address,
            pincode: provider.pincode,
            shopImageUrl: provider.shopImageUrl || null,
            serviceRadiusKm: provider.serviceRadiusKm,
            gstNumber: provider.gstNumber || null,
            expertise: provider.expertise || []
          }));

          return {
            tier: 2,
            tierName: 'Zhini Verified Partner',
            data: providerList
          };
        }
      } catch (err) {
        console.warn(`⚠️ Tier 2 execution failed or bypassed: ${err.message}`);
      }

      // -------------------------------------------------------------
      // TIER 3 (Fallback): OUT OF WARRANTY + NO ZHINI PROVIDER -> Top 5 General
      // -------------------------------------------------------------
      console.log(`🏢 Tier 3 Fallback Triggered: Fetching Top 5 local centers for ${brand || product} in ${pincode}`);
      const cacheKeyTier3 = `tier3_${brand}_${product}_${pincode}`.toLowerCase().replace(/\s+/g, '');

      const cachedTier3 = await cacheCollection.findOne({ key: cacheKeyTier3 });
      if (cachedTier3 && (Date.now() - cachedTier3.timestamp) < CACHE_EXPIRATION_MS) {
        console.log(`💾 Cache Hit (Tier 3): ${cacheKeyTier3}`);
        return { tier: 3, tierName: 'General Top Rated', data: cachedTier3.data };
      }

      const rawCenters = await scrapeServiceCenters(brand, product, pincode, { authorizedOnly: false });

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
    const gstNumber = body["gstNumber"] || null;
    const address = body["address"];
    const pincode = body["pincode"] || null;

    if (!name || !mobile || !range || !expertiseInput || !address) {
      return c.json({
        success: false,
        message: "Missing required fields: name, mobile, range, or expertise."
      }, 400);
    }

    const cleanMobile = mobile.trim();

    // 2. Format expertise (handles comma-separated string or array)
    let expertise = [];
    if (typeof expertiseInput === "string") {
      expertise = expertiseInput.split(",").map((e) => e.trim()).filter(Boolean);
    } else if (Array.isArray(expertiseInput)) {
      expertise = expertiseInput.map((e) => String(e).trim());
    }

    // 3. Handle optional shop photo upload to MinIO
    let shopImageUrl = null;
    const photoFile = body["photo"];

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

    // 4. Create Wekan Board for Provider
    console.log(`📋 Provisioning Wekan Board for Provider: ${cleanMobile}`);
    const boardResult = await createProviderBoard(cleanMobile);

    // 5. Construct document payload
    const newProvider = {
      name: name.trim(),
      mobile: cleanMobile,
      expertise,
      serviceRadiusKm: Number(range) || range,
      gstNumber: gstNumber ? gstNumber.trim() : null,
      shopImageUrl,
      status: "active",
      address: address.trim(),
      pincode: pincode ? pincode.trim() : null,
      wekanBoardId: boardResult.boardId,
      wekanLists: boardResult.lists,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // 6. Query database using withDatabase wrapper
    const result = await withDatabase(mongoUri, async (db) => {
      const collection = db.collection("Service-Providers");
      return await collection.insertOne(newProvider);
    });

    return c.json({
      success: true,
      message: "Service Provider created successfully with Wekan board.",
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

export const createServiceTicket = async (c) => {
  try {
    let body = {};

    try {
      body = await c.req.json();
    } catch (_) {
      body = await c.req.parseBody();
    }

    const customerName = body.customerName || body.customer_name;
    const custNumber = body.cust_number || body.customerPhone || body.mobile;
    const address = body.address;
    const description = body.description || body.notes || "Service Request";
    const providerMobile = body.providerMobile;

    const rawAvailableTime = body.availableTime || body.preferredTime || body.timeSlot;
    const availableTime = rawAvailableTime ? String(rawAvailableTime).trim() : "Flexible / Not specified";

    if (!customerName || !custNumber || !address || !providerMobile) {
      return c.json({
        success: false,
        message: "Missing required fields: customerName, cust_number, address, and providerMobile are required.",
      }, 400);
    }

    const ticketResult = await withDatabase(mongoUri, async (db) => {
      const providerCollection = db.collection("Service-Providers");
      const wekanServiceCollection = db.collection("wekan-services");

      const cleanProviderMobile = providerMobile.trim();

      // 1. Fetch Provider record to get board context
      let provider = await providerCollection.findOne({ mobile: cleanProviderMobile });

      let boardId = provider?.wekanBoardId;
      let newListId = provider?.wekanLists?.["New"];

      // 2. Fallback: If board or list mapping is missing, provision new board and sync back to MongoDB
      if (!boardId || !newListId) {
        console.warn(`⚠️ Board info missing for provider '${cleanProviderMobile}'. Provisioning now...`);
        const boardResult = await createProviderBoard(cleanProviderMobile);
        boardId = boardResult.boardId;
        newListId = boardResult.lists["New"];

        if (provider) {
          await providerCollection.updateOne(
            { mobile: cleanProviderMobile },
            {
              $set: {
                wekanBoardId: boardId,
                wekanLists: boardResult.lists,
                updatedAt: new Date()
              }
            }
          );
        }
      }

      // 3. Format details and create card in Wekan under Customer Phone Swimlane
      const cardTitle = `Ticket: ${customerName.trim()} (${custNumber.trim()})`;
      const cardDescription = `Customer Name: ${customerName.trim()}\nCustomer Phone: ${custNumber.trim()}\nAddress: ${address.trim()}\nAvailable Time: ${availableTime}\nDescription: ${description.trim()}`;

      const cardId = await createServiceCard(boardId, newListId, {
        title: cardTitle,
        description: cardDescription,
        customerPhone: custNumber.trim(),
      });

      // 4. Save ticket document in 'wekan-services' collection
      const ticketRecord = {
        ticketId: `TICK-${Date.now()}`,
        assignedTo: cleanProviderMobile,
        customerDetails: {
          name: customerName.trim(),
          phone: custNumber.trim(),
          address: address.trim(),
        },
        serviceDetails: {
          description: description.trim(),
          availableTime: availableTime,
        },
        wekan: {
          boardId: boardId,
          cardId: cardId,
          listId: newListId,
        },
        status: "NEW",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await wekanServiceCollection.insertOne(ticketRecord);
      return ticketRecord;
    });

    return c.json({
      success: true,
      message: "Ticket created and assigned to service provider.",
      data: ticketResult,
    }, 201);

  } catch (error) {
    console.error("❌ Create Service Ticket Controller Error:", error);

    return c.json({
      success: false,
      message: "Failed to create service ticket",
      error: error.message,
    }, 500);
  }
};


export const getProviderTickets = async (c) => {
  try {
    let body = {};
    try {
      body = await c.req.json();
    } catch (_) { }

    const providerMobile = body.providerMobile || c.req.query('providerMobile') || c.req.query('mobile');

    if (!providerMobile) {
      return c.json({
        success: false,
        message: "providerMobile query param or body field is required."
      }, 400);
    }

    const tickets = await withDatabase(mongoUri, async (db) => {
      const wekanServiceCollection = db.collection("wekan-services");
      return await wekanServiceCollection
        .find({ assignedTo: providerMobile.trim() })
        .sort({ createdAt: -1 })
        .toArray();
    });

    return c.json({
      success: true,
      count: tickets.length,
      data: tickets
    }, 200);

  } catch (error) {
    console.error("❌ Get Provider Tickets Controller Error:", error);
    return c.json({
      success: false,
      message: "Failed to fetch provider tickets",
      error: error.message
    }, 500);
  }
};

export const getServiceProviderByMobile = async (c) => {
  try {
    // 1. Extract mobile number from query params
    const mobile = c.req.query("mobile");

    // 2. Validate input
    if (!mobile) {
      return c.json({
        success: false,
        message: "Mobile number is required as a query parameter."
      }, 400);
    }

    const cleanMobile = mobile.trim();

    // 3. Query database using withDatabase wrapper
    const providers = await withDatabase(mongoUri, async (db) => {
      const collection = db.collection("Service-Providers");

      // Find all matching service provider profiles for this mobile
      return await collection.find({ mobile: cleanMobile }).toArray();
    });

    // 4. Handle case where no record is found
    if (!providers || providers.length === 0) {
      return c.json({
        success: false,
        message: "No service provider profile found for this mobile number.",
        count: 0,
        data: []
      }, 404);
    }

    // 5. Return success response
    return c.json({
      success: true,
      message: `Successfully retrieved ${providers.length} service provider record(s).`,
      count: providers.length,
      data: providers
    }, 200);

  } catch (error) {
    console.error("❌ Get Service Provider Controller Error:", error);
    return c.json({
      success: false,
      message: "Internal Server Error",
      error: error.message
    }, 500);
  }
};

const STATUS_TO_WEKAN_LIST = {
  "NEW": "New",
  "ACCEPTED": "Accepted",
  "REJECTED": "Rejected",
  "IN_PROGRESS": "In Progress",
  "WAITING_FOR_PARTS": "Waiting for Parts",
  "COMPLETED": "Completed"
};

export const updateTicketStatus = async (c) => {
  try {
    let body = {};
    try {
      body = await c.req.json();
    } catch (_) {
      body = await c.req.parseBody();
    }

    const { ticketId, newStatus } = body;

    if (!ticketId || !newStatus) {
      return c.json({
        success: false,
        message: "Missing required fields: ticketId and newStatus are required."
      }, 400);
    }

    const normalizedStatus = String(newStatus).trim().toUpperCase();
    const targetListName = STATUS_TO_WEKAN_LIST[normalizedStatus];

    if (!targetListName) {
      return c.json({
        success: false,
        message: `Invalid status '${newStatus}'. Allowed statuses: ${Object.keys(STATUS_TO_WEKAN_LIST).join(", ")}`
      }, 400);
    }

    const updatedTicket = await withDatabase(mongoUri, async (db) => {
      const wekanServiceCollection = db.collection("wekan-services");
      const providerCollection = db.collection("Service-Providers");

      // 1. Fetch current ticket document from MongoDB
      const ticket = await wekanServiceCollection.findOne({ ticketId: ticketId.trim() });
      if (!ticket) {
        throw new Error(`Ticket '${ticketId}' not found in database.`);
      }

      const { boardId, cardId, listId: currentListId } = ticket.wekan;
      const assignedProviderMobile = ticket.assignedTo;

      // 2. Fetch Provider details to resolve list ID mapping
      let provider = await providerCollection.findOne({ mobile: assignedProviderMobile });
      let newListId = provider?.wekanLists?.[targetListName];

      // Fallback: If list mapping is missing on provider doc, fetch board structure directly from Wekan
      if (!newListId) {
        const boardResult = await createProviderBoard(assignedProviderMobile);
        newListId = boardResult.lists[targetListName];
      }

      if (!newListId) {
        throw new Error(`Target list '${targetListName}' could not be resolved on Wekan Board ${boardId}`);
      }

      // 3. Move card to the new list in Wekan
      await moveCardToList(boardId, currentListId, cardId, newListId);

      // 4. Update status and list context in MongoDB
      const updateResult = await wekanServiceCollection.findOneAndUpdate(
        { ticketId: ticketId.trim() },
        {
          $set: {
            status: normalizedStatus,
            "wekan.listId": newListId,
            updatedAt: new Date()
          }
        },
        { returnDocument: "after" }
      );

      return updateResult;
    });

    return c.json({
      success: true,
      message: `Ticket ${ticketId} updated to '${normalizedStatus}' successfully.`,
      data: updatedTicket
    }, 200);

  } catch (error) {
    console.error("❌ Update Ticket Status Controller Error:", error);
    return c.json({
      success: false,
      message: "Failed to update ticket status",
      error: error.message
    }, 500);
  }
};




