// Test script for filter functionality
const axios = require('axios');

const API_URL = 'http://localhost:3001/api';
const TEST_SLUG = 'wedding-test-feedback-event-2025-09-02';
const TEST_PASSWORD = 'StrongTiger3610%';

async function testFilterFunctionality() {
  try {
    console.log('Testing filter functionality...\n');
    
    // 1. Authenticate to get JWT token
    console.log('1. Authenticating with gallery...');
    const authResponse = await axios.post(`${API_URL}/auth/gallery-login`, {
      slug: TEST_SLUG,
      password: TEST_PASSWORD
    });
    
    const token = authResponse.data.token;
    console.log('✅ Authentication successful\n');
    
    // 2. Test fetching all photos (no filter)
    console.log('2. Fetching all photos (no filter)...');
    const allPhotosResponse = await axios.get(`${API_URL}/gallery/${TEST_SLUG}/photos`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log(`✅ Found ${allPhotosResponse.data.photos.length} total photos\n`);
    
    // 3. Test fetching with liked filter
    console.log('3. Testing filter for liked photos...');
    const guestId = 'test_guest_123';
    const likedPhotosResponse = await axios.get(`${API_URL}/gallery/${TEST_SLUG}/photos`, {
      params: { filter: 'liked', guest_id: guestId },
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log(`✅ Found ${likedPhotosResponse.data.photos.length} liked photos for guest ${guestId}\n`);
    
    // 4. Test fetching with favorited filter
    console.log('4. Testing filter for favorited photos...');
    const favoritedPhotosResponse = await axios.get(`${API_URL}/gallery/${TEST_SLUG}/photos`, {
      params: { filter: 'favorited', guest_id: guestId },
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log(`✅ Found ${favoritedPhotosResponse.data.photos.length} favorited photos for guest ${guestId}\n`);
    
    // 5. Test combined filter
    console.log('5. Testing combined filter (liked OR favorited)...');
    const combinedPhotosResponse = await axios.get(`${API_URL}/gallery/${TEST_SLUG}/photos`, {
      params: { filter: 'liked,favorited', guest_id: guestId },
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log(`✅ Found ${combinedPhotosResponse.data.photos.length} photos that are liked OR favorited\n`);
    
    console.log('🎉 All filter tests passed successfully!');
    
  } catch (error) {
    console.error('❌ Test failed:', error.response?.data || error.message);
    process.exit(1);
  }
}

// Run the test
testFilterFunctionality();