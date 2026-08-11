import { withDatabase } from '../utils/config.js';
import { ObjectId } from "mongodb";
import { GoogleGenAI, Type } from "@google/genai";
import { uploadToR2 } from "../services/r2.service.js";
import path from 'path';
import crypto from 'crypto';



const mongoUri = process.env.MONGODB_URI;



export const createProductSubmission = async (c) => {
  try {
    // 1. Parse multipart/form-data request
    const body = await c.req.parseBody();

    const homeId = body.homeId;
    const name = body.name;
    const mobile = body.mobile;
    const address = body.address;
    const roomName = body.roomName;
    const product = body.product;
    const brand = body.brand;
    const warranty = body.warranty;
    const file = body.file; // File object or undefined

    // Validation
    if (!mobile || !product || !brand) {
      return c.json({ success: false, message: "Missing required fields (mobile, product, brand)." }, 400);
    }

    // 2. Handle Cloudflare R2 Image Upload
    let imageUrl = null;
    if (file && typeof file !== 'string' && file.name) {
      imageUrl = await uploadToR2(file, "product-images");
    }

    const cleanMobile = mobile.trim();
    const cleanName = (name || "Member").trim();
    const normalizedRoom = (roomName || "hall").trim().toLowerCase();
    const cleanAddress = address ? address.trim() : null;

    // 3. Database Operations across Decoupled Collections
    const result = await withDatabase(mongoUri, async (db) => {
      const usersCol = db.collection("users");
      const homesCol = db.collection("homes");
      const roomsCol = db.collection("rooms");
      const devicesCol = db.collection("devices");

      // --- STEP A: Upsert User Profile ---
      const numMobile = Number(cleanMobile);
      
      let user = await usersCol.findOneAndUpdate(
        { 
          $or: [
            { mobile: cleanMobile },
            { mobile: isNaN(numMobile) ? cleanMobile : numMobile }
          ]
        },
        {
          $setOnInsert: {
            name: cleanName,
            mobile: cleanMobile,
            roles: ["member"], // Default role
            createdAt: new Date().toISOString()
          },
          $set: { updatedAt: new Date().toISOString() }
        },
        { upsert: true, returnDocument: "after" }
      );

      let targetHomeId;

      // --- STEP B: Resolve or Upsert Home ---
      if (homeId) {
        if (!ObjectId.isValid(homeId)) {
          throw new Error("INVALID_HOME_ID");
        }
        targetHomeId = new ObjectId(homeId);

        const existingHome = await homesCol.findOne({ _id: targetHomeId });
        if (!existingHome) {
          throw new Error("HOME_NOT_FOUND");
        }

        // Link user to home members array
        await homesCol.updateOne(
          { _id: targetHomeId },
          {
            $addToSet: { 
              members: user._id,
              memberIds: user._id 
            },
            $set: { updatedAt: new Date().toISOString() }
          }
        );
      } else {
        if (!cleanAddress) {
          throw new Error("MISSING_ADDRESS");
        }

        // Check if an existing home document already matches this user & address
        let existingUserHome = await homesCol.findOne({
          $and: [
            {
              $or: [
                { ownerId: user._id },
                { userId: user._id },
                { members: user._id },
                { memberIds: user._id },
                { mobile: cleanMobile }
              ]
            },
            { address: { $regex: new RegExp(`^${cleanAddress.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}$`, 'i') } }
          ]
        });

        if (existingUserHome) {
          // Reuse existing home ID
          targetHomeId = existingUserHome._id;
        } else {
          // Create new Home record ONLY if no matching home exists
          const newHomeResult = await homesCol.insertOne({
            address: cleanAddress,
            pincode: typeof extractPincodeFromAddress === 'function' ? extractPincodeFromAddress(cleanAddress) : null,
            ownerId: user._id,
            userId: user._id,
            members: [user._id],
            memberIds: [user._id],
            mobile: cleanMobile,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
          targetHomeId = newHomeResult.insertedId;
        }
      }

      // --- STEP C: Resolve or Create Room ---
      let room = await roomsCol.findOne({
        $or: [
          { homeId: targetHomeId },
          { homeId: targetHomeId.toString() }
        ],
        roomName: { $regex: new RegExp(`^${normalizedRoom}$`, 'i') }
      });

      if (!room) {
        const newRoomResult = await roomsCol.insertOne({
          homeId: targetHomeId,
          roomName: normalizedRoom,
          createdAt: new Date().toISOString()
        });
        room = { _id: newRoomResult.insertedId, roomName: normalizedRoom };
      }

      // --- STEP D: Create Device Entry ---
      const deviceId = `DEV-${Date.now()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

      const newDevice = {
        deviceId: deviceId,
        homeId: targetHomeId,
        roomId: room._id,
        product: product.trim(),
        brand: brand.trim(),
        warranty: warranty || null,
        imageUrl: imageUrl, // Stores the public R2 URL
        addedByUserId: user._id,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      const deviceInsertResult = await devicesCol.insertOne(newDevice);

      return {
        deviceId: deviceId,
        deviceDbId: deviceInsertResult.insertedId,
        homeId: targetHomeId,
        roomId: room._id,
        userId: user._id
      };
    });

    return c.json({ success: true, message: "Device registered successfully.", data: result }, 200);

  } catch (error) {
    console.error("❌ Controller Error:", error);

    if (error.message === "INVALID_HOME_ID") {
      return c.json({ success: false, message: "Invalid homeId format provided." }, 400);
    }
    if (error.message === "HOME_NOT_FOUND") {
      return c.json({ success: false, message: "No home record found with the provided homeId." }, 404);
    }
    if (error.message === "MISSING_ADDRESS") {
      return c.json({ success: false, message: "Address is required when creating a new home record." }, 400);
    }

    return c.json({ success: false, message: "Internal Server Error", error: error.message }, 500);
  }
};

export const updateEntity = async (c) => {
  try {
    const body = await c.req.json();
    const { homeId, deviceId, roomId, address, pincode, product, brand, roomName } = body;

    if (!homeId && !deviceId && !roomId) {
      return c.json({ error: "Missing ID: Provide homeId, deviceId, or roomId to update" }, 400);
    }

    const result = await withDatabase(mongoUri, async (db) => {
      let updatedCount = 0;

      // 1. Update Home / Address
      if (homeId && (address || pincode)) {
        const homeUpdates = {};
        if (address) homeUpdates.address = address;
        if (pincode) homeUpdates.pincode = pincode;
        homeUpdates.updatedAt = new Date();

        const res = await db.collection("homes").updateOne(
          { _id: new ObjectId(homeId) },
          { $set: homeUpdates }
        );
        updatedCount += res.modifiedCount;
      }

      // 2. Update Device / Product Details
      if (deviceId && (product || brand)) {
        const deviceUpdates = {};
        if (product) deviceUpdates.product = product;
        if (brand) deviceUpdates.brand = brand;
        deviceUpdates.updatedAt = new Date();

        const res = await db.collection("devices").updateOne(
          { deviceId: deviceId },
          { $set: deviceUpdates }
        );
        updatedCount += res.modifiedCount;
      }

      // 3. Update Room Details
      if (roomId && roomName) {
        const roomUpdates = {
          roomName: roomName,
          updatedAt: new Date()
        };

        const res = await db.collection("rooms").updateOne(
          { _id: new ObjectId(roomId) },
          { $set: roomUpdates }
        );
        updatedCount += res.modifiedCount;
      }

      return updatedCount;
    });

    return c.json({
      success: true,
      message: "Update processed successfully",
      recordsUpdated: result
    }, 200);

  } catch (error) {
    console.error("Error in updateEntity:", error);
    return c.json({ error: "Failed to update", details: error.message }, 500);
  }
};



// Helper function — extracts a 6-digit pincode from an address string
function extractPincodeFromAddress(address) {
  const match = address?.match(/\b\d{6}\b/);
  return match ? match[0] : null;
}

export const addMember = async (c) => {
  try {
    // 1. Extract homeId, primary user's mobile, new member's name, and new member's mobile
    const body = await c.req.json();
    const { homeId, myMobile, newName, newMobile } = body;

    // 2. Validate required inputs
    if (!homeId || !myMobile || !newMobile || !newName) {
      return c.json({
        success: false,
        message: "Missing fields! homeId, myMobile, newName, and newMobile are required."
      }, 400);
    }

    const cleanHomeId = homeId.trim();
    const cleanMyMobile = myMobile.trim();
    const cleanNewMobile = newMobile.trim();
    const cleanNewName = newName.trim();

    // Validate MongoDB ObjectId format
    if (!ObjectId.isValid(cleanHomeId)) {
      return c.json({
        success: false,
        message: "Invalid homeId format."
      }, 400);
    }

    // Prevent adding the same number to itself
    if (cleanMyMobile === cleanNewMobile) {
      return c.json({
        success: false,
        message: "You cannot add your own mobile number as a new member."
      }, 400);
    }

    // 3. Connect to database and process decoupled updates
    const result = await withDatabase(mongoUri, async (db) => {
      const usersCollection = db.collection("users");
      const homesCollection = db.collection("homes");

      // A. Verify primary user exists in Users collection
      const requesterUser = await usersCollection.findOne({ mobile: cleanMyMobile });
      if (!requesterUser) {
        return { status: "REQUESTER_NOT_FOUND" };
      }

      // B. Verify Home exists AND requester belongs to this home
      const targetHome = await homesCollection.findOne({
        _id: new ObjectId(cleanHomeId),
        members: requesterUser._id
      });

      if (!targetHome) {
        return { status: "HOME_NOT_FOUND" };
      }

      // C. Find or create the new member profile in Users collection
      let newMemberUser = await usersCollection.findOne({ mobile: cleanNewMobile });

      if (!newMemberUser) {
        const newUserResult = await usersCollection.insertOne({
          name: cleanNewName,
          mobile: cleanNewMobile,
          roles: ["member"],
          createdAt: new Date(),
          updatedAt: new Date()
        });
        newMemberUser = { _id: newUserResult.insertedId };
      }

      // D. Check if new member is already in THIS home's members array
      const isAlreadyMember = targetHome.members.some(
        (memberId) => memberId.toString() === newMemberUser._id.toString()
      );

      if (isAlreadyMember) {
        return { status: "ALREADY_EXISTS" };
      }

      // E. Add the new member's userId to Homes.members array
      await homesCollection.updateOne(
        { _id: targetHome._id },
        {
          $push: { members: newMemberUser._id },
          $set: { updatedAt: new Date() }
        }
      );

      return { status: "SUCCESS" };
    });

    // 4. Handle response states
    if (result.status === "REQUESTER_NOT_FOUND") {
      return c.json({
        success: false,
        message: "Your user account was not found."
      }, 404);
    }

    if (result.status === "HOME_NOT_FOUND") {
      return c.json({
        success: false,
        message: "Home record not found or you do not have permission to modify this home."
      }, 404);
    }

    if (result.status === "ALREADY_EXISTS") {
      return c.json({
        success: false,
        message: "This mobile number is already added as a member in this household."
      }, 400);
    }

    // 5. Return success response
    return c.json({
      success: true,
      message: `${cleanNewName} added successfully! They can now access all shared appliances in this home.`
    }, 200);

  } catch (error) {
    console.error("❌ Add Member Controller Error:", error);
    return c.json({
      success: false,
      message: "Internal Server Error",
      error: error.message
    }, 500);
  }
};

export const deleteMember = async (c) => {
  const homeId = c.req.param('homeId');
  const { mobile } = await c.req.json(); // Identify member by mobile number

  const result = await withDatabase(mongoUri, async (db) => {
    return await db.collection('homes').updateOne(
      { _id: new ObjectId(homeId) },
      {
        $pull: {
          members: { mobile: mobile } // Pulls out the member matching this mobile
        },
        $set: { updatedAt: new Date().toISOString() }
      }
    );
  });

  if (result.modifiedCount === 0) {
    return c.json({ success: false, message: 'Home or member not found' }, 404);
  }

  return c.json({ success: true, message: 'Member deleted successfully' });
};

export const deleteRoomProduct = async (c) => {
  const homeId = c.req.param('homeId');
  const { roomName, product } = await c.req.json(); // e.g., roomName: "kitchen", product: "Laptop"

  const result = await withDatabase(mongoUri, async (db) => {
    return await db.collection('homes').updateOne(
      { _id: new ObjectId(homeId) },
      {
        $pull: {
          [`rooms.${roomName}`]: { product: product } // Dynamic key for room (e.g., rooms.kitchen)
        },
        $set: { updatedAt: new Date().toISOString() }
      }
    );
  });

  if (result.modifiedCount === 0) {
    return c.json({ success: false, message: 'Home, room, or product not found' }, 404);
  }

  return c.json({ success: true, message: 'Product deleted successfully' });
};


const GEMINI_KEYS = [
  process.env.KEY_1,
  process.env.KEY_2,
  process.env.KEY_3,
].filter(Boolean);

let currentGeminiKeyIndex = 0;

export const AIassist = async (c) => {
  try {
    const { imageBase64, mimeType = "image/jpeg" } = await c.req.json();

    if (!imageBase64) {
      return c.json({ success: false, message: "No imageBase64 provided" }, 400);
    }

    if (GEMINI_KEYS.length === 0) {
      return c.json({ success: false, message: "No API keys configured" }, 500);
    }

    const promptText =
      "Identify the appliance in this image. Return ONLY a raw JSON object with exactly two keys: 'brand' and 'product'. Example: {\"brand\": \"Samsung\", \"product\": \"Washing Machine\"}";

    let responseText;
    let geminiAttempts = 0;

    // Cycle through available Gemini API keys on failure
    while (geminiAttempts < GEMINI_KEYS.length) {
      const apiKey = GEMINI_KEYS[currentGeminiKeyIndex];

      try {
        console.log(`🤖 Attempting Gemini execution with Key index: ${currentGeminiKeyIndex}`);
        const ai = new GoogleGenAI({ apiKey });

        const response = await ai.models.generateContent({
          model: "gemini-2.5-flash",
          contents: [
            {
              inlineData: {
                mimeType: mimeType,
                data: imageBase64,
              },
            },
            promptText, // Text prompt passed alongside inlineData
          ],
          config: {
            responseMimeType: "application/json",
          },
        });

        responseText = response.text;
        console.log("✅ Gemini execution successful!");
        break; // Exit loop on success
      } catch (err) {
        console.warn(`⚠️ Gemini key index ${currentGeminiKeyIndex} failed: ${err.message}. Rotating key...`);
        geminiAttempts++;
        currentGeminiKeyIndex = (currentGeminiKeyIndex + 1) % GEMINI_KEYS.length;
      }
    }

    // Exhausted all key attempts
    if (!responseText) {
      return c.json(
        { success: false, message: "All Gemini API keys failed or quota exceeded." },
        429
      );
    }

    // Safely parse JSON response
    const cleanedText = responseText.replace(/```json|```/g, "").trim();
    const parsedResult = JSON.parse(cleanedText);

    return c.json({
      success: true,
      data: parsedResult,
    });
  } catch (error) {
    console.error("❌ AI Assist Error:", error.message);
    return c.json(
      { success: false, message: "Failed to identify product from image", error: error.message },
      500
    );
  }
};

export const getSubmissionByMobile = async (c) => {
  try {
    const mobile = c.req.query("mobile");

    if (!mobile) {
      return c.json({
        success: false,
        message: "Mobile number is required as a query parameter."
      }, 400);
    }

    const cleanMobile = mobile.trim();
    const numMobile = Number(cleanMobile);

    const homes = await withDatabase(mongoUri, async (db) => {
      // 1. Fetch User by Mobile
      const user = await db.collection("users").findOne({
        $or: [
          { mobile: cleanMobile },
          { mobile: isNaN(numMobile) ? cleanMobile : numMobile }
        ]
      });

      if (!user) {
        return [];
      }

      const userIdStr = user._id.toString();
      const userIdObj = user._id instanceof ObjectId ? user._id : new ObjectId(user._id);

      // 2. Aggregate Homes
      const rawHomes = await db.collection("homes").aggregate([
        // Match candidates
        {
          $match: {
            $or: [
              {
                $expr: {
                  $let: {
                    vars: { safeMembers: { $ifNull: ["$members", []] } },
                    in: {
                      $or: [
                        { $in: [userIdObj, "$$safeMembers"] },
                        { $in: [userIdStr, "$$safeMembers"] }
                      ]
                    }
                  }
                }
              },
              { userId: userIdObj },
              { userId: userIdStr },
              { ownerId: userIdObj },
              { ownerId: userIdStr },
              { createdBy: userIdObj },
              { createdBy: userIdStr },
              { mobile: cleanMobile },
              { mobile: isNaN(numMobile) ? cleanMobile : numMobile }
            ]
          }
        },

        // ★ Primary uniqueness: always group by real document _id
        {
          $group: {
            _id: "$_id",
            doc: { $first: "$$ROOT" }
          }
        },
        {
          $replaceRoot: {
            newRoot: "$doc"
          }
        },

        // Optional secondary collapse by name (only useful if you still have
        // dirty test documents that share a name but have different _ids)
        {
          $group: {
            _id: { $ifNull: ["$name", "$_id"] },
            doc: { $first: "$$ROOT" }
          }
        },
        {
          $replaceRoot: {
            newRoot: "$doc"
          }
        },

        // Prepare ID variants for joins
        {
          $addFields: {
            homeIdVariants: ["$_id", { $toString: "$_id" }]
          }
        },

        // Join Users
        {
          $lookup: {
            from: "users",
            let: { memberList: { $ifNull: ["$members", []] } },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $or: [
                      { $in: ["$_id", "$$memberList"] },
                      { $in: [{ $toString: "$_id" }, "$$memberList"] }
                    ]
                  }
                }
              },
              { $project: { createdAt: 0, updatedAt: 0 } }
            ],
            as: "members"
          }
        },

        // Join Rooms
        {
          $lookup: {
            from: "rooms",
            let: { hVariants: "$homeIdVariants" },
            pipeline: [
              {
                $match: {
                  $expr: { $in: ["$homeId", "$$hVariants"] }
                }
              }
            ],
            as: "rooms"
          }
        },

        // Join Devices
        {
          $lookup: {
            from: "devices",
            let: { hVariants: "$homeIdVariants" },
            pipeline: [
              {
                $match: {
                  $expr: { $in: ["$homeId", "$$hVariants"] }
                }
              }
            ],
            as: "devices"
          }
        },

        // Nest Devices into Rooms
        {
          $addFields: {
            rooms: {
              $map: {
                input: "$rooms",
                as: "room",
                in: {
                  $mergeObjects: [
                    "$$room",
                    {
                      devices: {
                        $filter: {
                          input: "$devices",
                          as: "device",
                          cond: {
                            $or: [
                              { $eq: ["$$device.roomId", "$$room._id"] },
                              {
                                $eq: [
                                  { $toString: "$$device.roomId" },
                                  { $toString: "$$room._id" }
                                ]
                              }
                            ]
                          }
                        }
                      }
                    }
                  ]
                }
              }
            }
          }
        },

        {
          $project: {
            homeIdVariants: 0,
            devices: 0
          }
        }
      ]).toArray();

      // Final safety net – key purely by _id
      const uniqueMap = new Map();
      for (const home of rawHomes) {
        const key = home._id.toString();
        if (!uniqueMap.has(key)) {
          uniqueMap.set(key, home);
        }
      }

      return Array.from(uniqueMap.values());
    });

    if (!homes || homes.length === 0) {
      return c.json({
        success: false,
        message: "No household records found for this mobile number.",
        count: 0,
        data: []
      }, 404);
    }

    return c.json({
      success: true,
      message: `Found ${homes.length} household(s) associated with this request.`,
      count: homes.length,
      data: homes
    }, 200);

  } catch (error) {
    console.error("❌ Get Submission Controller Error:", error);
    return c.json({
      success: false,
      message: "Internal Server Error",
      error: error.message
    }, 500);
  }
};