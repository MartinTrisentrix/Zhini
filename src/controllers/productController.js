import { withDatabase } from '../utils/config.js';
import { ObjectId } from "mongodb";
import { GoogleGenAI, Type } from "@google/genai";



const mongoUri = process.env.MONGODB_URI;



export const createProductSubmission = async (c) => {
  try {
    const { homeId, name, mobile, address, roomName, product, brand, warranty } = await c.req.json();

    // Mobile, product, and brand are mandatory for both flows
    if (!mobile || !product || !brand) {
      return c.json({ success: false, message: "Missing required fields (mobile, product, brand)." }, 400);
    }

    const cleanMobile = mobile.trim();
    const cleanName = (name || "Member").trim();
    const normalizedRoom = (roomName || "hall").trim().toLowerCase();

    const newProduct = {
      product: product.trim(),
      brand: brand.trim(),
      warranty: warranty || null,
      createdAt: new Date().toISOString()
    };

    const result = await withDatabase(mongoUri, async (db) => {
      const collection = db.collection("Home");

      // =======================================================================
      // BRANCH 1: ADD PRODUCT TO AN EXISTING HOME (homeId is provided)
      // =======================================================================
      if (homeId) {
        if (!ObjectId.isValid(homeId)) {
          throw new Error("INVALID_HOME_ID");
        }

        const existingHome = await collection.findOne({ _id: new ObjectId(homeId) });

        if (!existingHome) {
          throw new Error("HOME_NOT_FOUND");
        }

        // Push product into the dynamic room of the targeted home
        return await collection.findOneAndUpdate(
          { _id: new ObjectId(homeId) },
          {
            $set: { updatedAt: new Date().toISOString() },
            $push: { [`rooms.${normalizedRoom}`]: newProduct }
          },
          { returnDocument: "after" }
        );
      }

      // =======================================================================
      // BRANCH 2: CREATE A BRAND NEW HOME RECORD (homeId is missing/null)
      // =======================================================================
      if (!address) {
        throw new Error("MISSING_ADDRESS");
      }

      const newHome = {
        address: address.trim(),
        pincode: extractPincodeFromAddress(address),
        members: [{ name: cleanName, mobile: cleanMobile }],
        rooms: {
          [normalizedRoom]: [newProduct]
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      const insertResult = await collection.insertOne(newHome);
      return { _id: insertResult.insertedId, ...newHome };
    });

    return c.json({ success: true, data: result }, 200);

  } catch (error) {
    console.error("❌ Controller Error:", error);

    // Specific error handling for the Database block
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


export const updateHomeAddress = async (c) => {
  try {
    const homeId = c.req.param('homeId');
    const { address, pincode } = await c.req.json();

    if (!homeId || !ObjectId.isValid(homeId)) {
      return c.json({ success: false, message: 'Invalid homeId' }, 400);
    }

    const updateFields = {};
    if (address !== undefined) updateFields.address = address.trim();
    if (pincode !== undefined) updateFields.pincode = pincode.toString().trim();

    updateFields.updatedAt = new Date().toISOString();

    const result = await withDatabase(mongoUri, async (db) => {
      return await db.collection('Home').findOneAndUpdate(
        { _id: new ObjectId(homeId) },
        { $set: updateFields },
        { returnDocument: 'after' }
      );
    });

    if (!result) {
      return c.json({ success: false, message: 'Home not found' }, 404);
    }

    return c.json({
      success: true,
      message: 'Address updated successfully',
      data: result
    });

  } catch (error) {
    return c.json({ success: false, message: error.message }, 500);
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

    // 3. Connect to database and update
    const result = await withDatabase(mongoUri, async (db) => {
      const collection = db.collection("Home");

      // Find the SPECIFIC home document by _id where the primary user is a member
      const targetHome = await collection.findOne({
        _id: new ObjectId(cleanHomeId),
        "members.mobile": cleanMyMobile
      });

      if (!targetHome) {
        return { status: "NOT_FOUND" };
      }

      // Check if the new member is already in THIS specific household
      const isAlreadyMember = targetHome.members.some(
        (member) => member.mobile === cleanNewMobile
      );

      if (isAlreadyMember) {
        return { status: "ALREADY_EXISTS" };
      }

      // Add the new member object { name, mobile } to the members array of this home
      const updateResult = await collection.updateOne(
        { _id: targetHome._id },
        {
          $push: {
            members: {
              name: cleanNewName,
              mobile: cleanNewMobile
            }
          },
          $set: { updatedAt: new Date().toISOString() }
        }
      );

      return { status: "SUCCESS", updateResult };
    });

    // 4. Handle response states
    if (result.status === "NOT_FOUND") {
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

const Z_AI_KEYS = [
  process.env.Z_KEY_1,
  process.env.Z_KEY_2,
  process.env.Z_KEY_3,
].filter(Boolean);

// 2. Gemini Key Array
const GEMINI_KEYS = [
  process.env.KEY_1,
  process.env.KEY_2,
  process.env.KEY_3
  
].filter(Boolean);

let currentZKeyIndex = 0;
let currentGeminiKeyIndex = 0;

export const AIassist = async (c) => {
  try {
    const { imageBase64, mimeType = "image/jpeg" } = await c.req.json();

    if (!imageBase64) {
      return c.json({ success: false, message: "No imageBase64 provided" }, 400);
    }

    const promptText =
      "Identify the appliance in this image. Return ONLY a raw JSON object with exactly two keys: 'brand' and 'product'. Example: {\"brand\": \"Samsung\", \"product\": \"Washing Machine\"}";

    let responseText;

    // ==========================================
    // 1. PRIMARY: Try Z AI with Key Rotation + Model Fallback
    // ==========================================
    if (Z_AI_KEYS.length > 0) {
      const zaiVisionModels = ["glm-4.6v-flash", "glm-4.5v", "glm-4.6v"]; // Best → Good → Stronger
      let zAttempts = 0;

      while (zAttempts < Z_AI_KEYS.length * zaiVisionModels.length) {
        const zApiKey = Z_AI_KEYS[currentZKeyIndex];
        const currentModel = zaiVisionModels[zAttempts % zaiVisionModels.length];

        try {
          console.log(`Attempting Z AI → Key ${currentZKeyIndex} | Model: ${currentModel}`);

          const zAiResponse = await fetch("https://api.z.ai/api/paas/v4/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${zApiKey}`,
            },
            body: JSON.stringify({
              model: currentModel,
              messages: [
                {
                  role: "user",
                  content: [
                    {
                      type: "image_url",
                      image_url: {
                        url: `data:${mimeType};base64,${imageBase64}`,
                      },
                    },
                    {
                      type: "text",
                      text: promptText,
                    },
                  ],
                },
              ],
              response_format: { type: "json_object" },
              max_tokens: 300,
              temperature: 0.1,
            }),
          });

          if (zAiResponse.ok) {
            const zAiData = await zAiResponse.json();
            responseText = zAiData.choices?.[0]?.message?.content;
            console.log(`✅ Z AI Success! (Model: ${currentModel})`);
            break;
          } else {
            const errData = await zAiResponse.text();
            console.warn(`Z AI failed → Key ${currentZKeyIndex} | Model ${currentModel} | ${zAiResponse.status}: ${errData}`);
            
            // Rotate key after trying all models for current key
            if ((zAttempts + 1) % zaiVisionModels.length === 0) {
              currentZKeyIndex = (currentZKeyIndex + 1) % Z_AI_KEYS.length;
            }
            zAttempts++;
          }
        } catch (zAiErr) {
          console.warn(`Z AI error → Key ${currentZKeyIndex}:`, zAiErr.message);
          zAttempts++;
          if (zAttempts % zaiVisionModels.length === 0) {
            currentZKeyIndex = (currentZKeyIndex + 1) % Z_AI_KEYS.length;
          }
        }
      }
    }

    // ==========================================
    // 2. FALLBACK: Gemini
    // ==========================================
    if (!responseText && GEMINI_KEYS.length > 0) {
      console.log("Z AI unavailable. Falling back to Gemini...");
      let geminiAttempts = 0;

      while (geminiAttempts < GEMINI_KEYS.length) {
        const apiKey = GEMINI_KEYS[currentGeminiKeyIndex];

        try {
          const ai = new GoogleGenAI({ apiKey });

          const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",   // or "gemini-1.5-flash" if needed
            contents: [
              {
                inlineData: {
                  mimeType: mimeType,
                  data: imageBase64,
                },
              },
              promptText,
            ],
            config: {
              responseMimeType: "application/json",
            },
          });

          responseText = response.text;
          console.log("✅ Gemini execution successful!");
          break;
        } catch (err) {
          console.warn(`Gemini key ${currentGeminiKeyIndex} failed. Rotating...`);
          geminiAttempts++;
          currentGeminiKeyIndex = (currentGeminiKeyIndex + 1) % GEMINI_KEYS.length;
        }
      }
    }

    // Final fallback if everything fails
    if (!responseText) {
      return c.json(
        { success: false, message: "All AI services and API keys are exhausted." },
        429
      );
    }

    // Clean and parse JSON
    const cleanedText = responseText.replace(/```json|```/g, "").trim();
    const parsedResult = JSON.parse(cleanedText);

    return c.json({
      success: true,
      data: parsedResult,
    });
  } catch (error) {
    console.error("AI Assist Error:", error.message);
    return c.json(
      { success: false, message: "Failed to identify product from image" },
      500
    );
  }
};

export const getSubmissionByMobile = async (c) => {
  try {
    // 1. Extract mobile number from query params (e.g., /api/home?mobile=9876543210)
    const mobile = c.req.query("mobile");

    // 2. Validate input
    if (!mobile) {
      return c.json({
        success: false,
        message: "Mobile number is required as a query parameter."
      }, 400);
    }

    const cleanMobile = mobile.trim();

    // 3. Query database using find() to get ALL matching household documents
    const homes = await withDatabase(mongoUri, async (db) => {
      const collection = db.collection("Home");

      // Finds all documents where members array contains an object with this mobile
      return await collection.find({ "members.mobile": cleanMobile }).toArray();
    });

    // 4. Handle case where no households are found
    if (!homes || homes.length === 0) {
      return c.json({
        success: false,
        message: "No household records found for this mobile number.",
        count: 0,
        data: []
      }, 404);
    }

    // 5. Return success response with array of homes
    return c.json({
      success: true,
      message: `Found ${homes.length} household(s) associated with this number.`,
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