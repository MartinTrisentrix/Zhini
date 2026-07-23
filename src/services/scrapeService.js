import axios from "axios";

const GOOGLE_PLACES_API_KEY = "AIzaSyB8fc4eAOjNO-yInTnJHdxov7B-SO3IUyQ";

export const scrapeServiceCenters = async (brand, product, pincode, options = { authorizedOnly: false }) => {
  try {
    const hasBrand = brand && brand.trim() && brand.toUpperCase() !== "N/A";
    const cleanBrand = hasBrand ? brand.trim() : "";
    const cleanProduct = product ? product.trim() : "";

    let queryTerm = "";

    if (options.authorizedOnly) {
      queryTerm = hasBrand 
        ? `${cleanBrand} ${cleanProduct} authorized service center` 
        : `${cleanProduct} authorized service center`;
    } else {
      queryTerm = hasBrand 
        ? `${cleanBrand} ${cleanProduct} repair service center` 
        : `${cleanProduct} repair service center`;
    }

    const searchQuery = `${queryTerm} near ${pincode}`;

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

    const fallbackName = options.authorizedOnly
      ? `${cleanBrand || cleanProduct} Authorized Service Center`
      : `${cleanProduct || cleanBrand} Repair Center`;

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


export const scrapeHomeServices = async (serviceType, pincode) => {
  try {
    const searchQuery = `${serviceType} near ${pincode}`;

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

    const normalizedData = places.map((place) => ({
      name: place.displayName?.text || `${serviceType} Services`,
      phone: place.nationalPhoneNumber || "N/A",
      address: place.formattedAddress || "Address not available",
      rating: place.rating ? place.rating.toString() : "N/A",
      type: serviceType
    }));

    return normalizedData;
  } catch (error) {
    console.error(
      "Google Places API Error (Home Services):",
      error.response?.data || error.message
    );
    throw new Error("Failed to fetch nearby home services.");
  }
};