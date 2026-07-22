import { withDatabase } from '../utils/config.js';
import { ObjectId } from "mongodb";
import { GoogleGenAI, Type } from "@google/genai";


const mongoUri = process.env.MONGODB_URI;

const ai = new GoogleGenAI({ apiKey: "AIzaSyCQv3jxyd3eFyEteDioW217cGbkLS6Nxgs" });

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


// Helper function — extracts a 6-digit pincode from an address string
function extractPincodeFromAddress(address) {
  const match = address?.match(/\b\d{6}\b/);
  return match ? match[0] : null;
}

export const addMember = async (c) => {
  try {
    // 1. Extract primary user's mobile, new member's name, and new member's mobile
    const body = await c.req.json();
    const { myMobile, newName, newMobile } = body;

    // 2. Validate required inputs
    if (!myMobile || !newMobile || !newName) {
      return c.json({
        success: false,
        message: "Missing fields! myMobile, newName, and newMobile are required."
      }, 400);
    }

    const cleanMyMobile = myMobile.trim();
    const cleanNewMobile = newMobile.trim();
    const cleanNewName = newName.trim();

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

      // Check if the new member is already part of the household to avoid duplicate entries
      const existingHousehold = await collection.findOne({
        "members.mobile": cleanMyMobile
      });

      if (!existingHousehold) {
        return { status: "NOT_FOUND" };
      }

      const isAlreadyMember = existingHousehold.members.some(
        (member) => member.mobile === cleanNewMobile
      );

      if (isAlreadyMember) {
        return { status: "ALREADY_EXISTS" };
      }

      // Add the new member object { name, mobile } to the members array
      const updateResult = await collection.updateOne(
        { _id: existingHousehold._id },
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
        message: "No home record found associated with your mobile number."
      }, 404);
    }

    if (result.status === "ALREADY_EXISTS") {
      return c.json({
        success: false,
        message: "This mobile number is already added as a member in your household."
      }, 400);
    }

    // 5. Return success response
    return c.json({
      success: true,
      message: `${cleanNewName} added successfully! They can now access all shared appliances.`
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

export const AIassist = async (c) => {
  try {
    // Parse the JSON request body in Hono
    const { imageBase64, mimeType = "image/jpeg" } = await c.req.json();

    if (!imageBase64) {
      return c.json(
        { success: false, message: "No imageBase64 provided" },
        400
      );
    }

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          inlineData: {
            mimeType: mimeType,
            data: imageBase64,
          },
        },
        "Identify the appliance in this image. Return ONLY a raw JSON object with exactly two keys: 'brand' and 'product'. Example: {\"brand\": \"Samsung\", \"product\": \"Washing Machine\"}",
      ],
      config: {
        responseMimeType: "application/json",
      },
    });

    const parsedResult = JSON.parse(response.text);

    return c.json({
      success: true,
      data: parsedResult,
    });
  } catch (error) {
    console.error("Gemini Vision Error:", error.message);
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