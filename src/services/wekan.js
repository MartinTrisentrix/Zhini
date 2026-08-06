// services/wekan.service.js

export const getWekanAuthHeaders = async () => {
  const baseUrl = process.env.WEKAN_BASE_URL || "http://localhost:8080";
  const username = process.env.WEKAN_ADMIN_USERNAME;
  const password = process.env.WEKAN_ADMIN_PASSWORD;

  // Debug log to confirm values aren't undefined
  if (!username || !password) {
    throw new Error("WEKAN_ADMIN_USERNAME or WEKAN_ADMIN_PASSWORD is missing from environment variables.");
  }

  const response = await fetch(`${baseUrl}/users/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: username,
      password: password,
    }),
  });

  if (!response.ok) {
    throw new Error(`Wekan login failed with status ${response.status}`);
  }

  const data = await response.json();

  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${data.token}`,
    "X-User-Id": data.id,
  };
};

export const createProviderBoard = async (mobileNumber) => {
  const baseUrl = process.env.WEKAN_BASE_URL || "http://localhost:8080";
  const headers = await getWekanAuthHeaders();
  
  // Requirement 1: Format title as mobileNumber_year (e.g., 9876543210_2026)
  const currentYear = new Date().getFullYear();
  const boardTitle = `${mobileNumber}_${currentYear}`;

  // 1. Create the Board
  const boardRes = await fetch(`${baseUrl}/api/boards`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      title: boardTitle,
      owner: headers["X-User-Id"],
      isAdmin: true,
      permission: "private",
    }),
  });

  if (!boardRes.ok) {
    const errText = await boardRes.text();
    throw new Error(`Board creation failed (${boardRes.status}): ${errText}`);
  }

  const boardData = await boardRes.json();
  const boardId = boardData._id;

  // Requirement 3: Added "Waiting for Parts" to required lists
  const requiredLists = [
    "New",
    "Accepted",
    "Rejected",
    "In Progress",
    "Waiting for Parts",
    "Completed",
  ];
  const listMap = {};

  // 2. Create lists
  for (const listTitle of requiredLists) {
    const listRes = await fetch(`${baseUrl}/api/boards/${boardId}/lists`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: listTitle }),
    });

    if (listRes.ok) {
      const listData = await listRes.json();
      listMap[listTitle] = listData._id;
    }
  }

  console.log(`✅ Created Wekan board "${boardTitle}" (ID: ${boardId})`);

  return {
    boardId,
    lists: listMap,
  };
};

export const createServiceCard = async (boardId, listId, { title, description, customerPhone }) => {
  const baseUrl = process.env.WEKAN_BASE_URL || "http://localhost:8080";
  const headers = await getWekanAuthHeaders();
  const userId = headers["X-User-Id"];

  // Fallback swimlane title if phone number isn't passed
  const swimlaneTitle = customerPhone || "General Customer";

  // 1. Fetch existing swimlanes for this board
  const swimlanesRes = await fetch(`${baseUrl}/api/boards/${boardId}/swimlanes`, {
    headers,
  });

  if (!swimlanesRes.ok) {
    const errText = await swimlanesRes.text();
    throw new Error(`Failed to fetch swimlanes (${swimlanesRes.status}): ${errText}`);
  }

  const swimlanes = await swimlanesRes.json();
  let targetSwimlane = swimlanes.find((s) => s.title === swimlaneTitle);

  // Requirement 2: Create a swimlane named after the Customer Mobile Number if it doesn't exist
  if (!targetSwimlane) {
    const createSwimlaneRes = await fetch(`${baseUrl}/api/boards/${boardId}/swimlanes`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: swimlaneTitle,
      }),
    });

    if (!createSwimlaneRes.ok) {
      const errText = await createSwimlaneRes.text();
      throw new Error(`Failed to create swimlane (${createSwimlaneRes.status}): ${errText}`);
    }

    targetSwimlane = await createSwimlaneRes.json();
    console.log(`✅ Created Swimlane "${swimlaneTitle}" (ID: ${targetSwimlane._id})`);
  }

  // 2. Create the Card with the Customer's Swimlane ID
  const res = await fetch(`${baseUrl}/api/boards/${boardId}/lists/${listId}/cards`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      title,
      description,
      authorId: userId,
      userId: userId,
      swimlaneId: targetSwimlane._id,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to create Wekan card (${res.status}): ${errText}`);
  }

  const card = await res.json();
  console.log(`✅ Created Card "${title}" (ID: ${card._id}) in Swimlane "${swimlaneTitle}"`);

  return card._id;
};

export const moveCardToList = async (boardId, currentListId, cardId, newListId) => {
  const baseUrl = process.env.WEKAN_BASE_URL || "http://localhost:8080";
  const headers = await getWekanAuthHeaders();

  const res = await fetch(
    `${baseUrl}/api/boards/${boardId}/lists/${currentListId}/cards/${cardId}`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify({
        listId: newListId,
      }),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to move Wekan card (${res.status}): ${errText}`);
  }

  console.log(`✅ Moved Card ${cardId} to List ${newListId}`);
  return true;
};