import { MongoClient } from 'mongodb';



let cachedClient = null;

export const withDatabase = async (uri, callback) => {
  try {
    if (!cachedClient) {
      console.log("🐘 MongoDB: Using Persistent Connection Pool");
      cachedClient = new MongoClient(uri, {
        maxPoolSize: 10,
        minPoolSize: 2,
        connectTimeoutMS: 5000,
        socketTimeoutMS: 45000, 
      });
      await cachedClient.connect();
    }

    // Changing the database name to "Zhini" for the new project
    const db = cachedClient.db("Zhini");
    return await callback(db);
    
  } catch (error) {
    console.error("❌ MongoDB Connection Error:", error);
    // Reset so the next request tries a fresh connection
    cachedClient = null; 
    throw error;
  }
};