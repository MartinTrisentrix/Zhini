import axios from "axios";

const GOOGLE_PLACES_API_KEY = "AIzaSyB8fc4eAOjNO-yInTnJHdxov7B-SO3IUyQ";


export const scrapeServiceCenters = async (brand, product, pincode) => {
  try {
    // Treat "N/A", null, undefined, or empty string as no brand
    const hasBrand = brand && brand.trim() && brand.toUpperCase() !== "N/A";
    const cleanBrand = hasBrand ? brand.trim() : "";
    const cleanProduct = product ? product.trim() : "";

  
    const queryTerm = hasBrand 
      ? `${cleanBrand} ${cleanProduct} authorized service center` 
      : `${cleanProduct} service center`;

    const searchQuery = `${queryTerm} near ${pincode} `;

    // 2. Make POST request to Google Places API (New Text Search)
    const response = await axios.post(
      "https://places.googleapis.com/v1/places:searchText",
      {
        textQuery: searchQuery,
      },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": GOOGLE_PLACES_API_KEY,
          "X-Goog-FieldMask":
            "places.displayName,places.nationalPhoneNumber,places.formattedAddress,places.rating",
        },
      }
    );

    const places = response.data.places || [];

    // 3. Map Google API fields with dynamic fallback naming
    const fallbackName = hasBrand 
      ? `${cleanBrand} Service Center` 
      : `${cleanProduct} Repair Center`;

    const normalizedData = places.map((place) => ({
      name: place.displayName?.text || fallbackName,
      phone: place.nationalPhoneNumber || "N/A",
      address: place.formattedAddress || "Address not available",
      rating: place.rating ? place.rating.toString() : "N/A",
    }));

    return normalizedData;
  } catch (error) {
    console.error(
      "Google Places API Error:",
      error.response?.data || error.message
    );
    throw new Error("Failed to fetch service centers from Google Places API.");
  }
};