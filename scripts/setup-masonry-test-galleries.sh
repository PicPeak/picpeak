#!/bin/bash
# Script to create test galleries for each masonry layout mode

set -e

BASE_URL="${BASE_URL:-http://localhost:7100}"
ADMIN_USER="${ADMIN_USERNAME:-admin}"
ADMIN_PASS="${ADMIN_PASSWORD:-admin}"
TEST_IMAGES_DIR="${1:-./test-images}"

echo "=== Setting up Masonry Layout Test Galleries ==="
echo "Base URL: $BASE_URL"
echo "Test images: $TEST_IMAGES_DIR"

# Login to get admin token
echo ""
echo "Logging in as admin..."
LOGIN_RESPONSE=$(curl -s -X POST "$BASE_URL/api/auth/admin/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\": \"$ADMIN_USER\", \"password\": \"$ADMIN_PASS\"}")

TOKEN=$(echo "$LOGIN_RESPONSE" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

if [ -z "$TOKEN" ]; then
  echo "Failed to login. Response: $LOGIN_RESPONSE"
  exit 1
fi

echo "Login successful!"

# Function to create a gallery with specific masonry mode
create_gallery() {
  local name="$1"
  local masonry_mode="$2"
  local description="$3"

  echo ""
  echo "Creating gallery: $name (masonry mode: $masonry_mode)"

  # Build color_theme JSON with galleryLayout and gallerySettings
  local color_theme=$(cat <<EOF
{
  "galleryLayout": "masonry",
  "gallerySettings": {
    "masonryMode": "$masonry_mode",
    "masonryGutter": 8,
    "masonryRowHeight": 250
  },
  "primaryColor": "#3B82F6",
  "backgroundColor": "#FFFFFF",
  "textColor": "#1F2937"
}
EOF
)

  # Escape for JSON
  local color_theme_escaped=$(echo "$color_theme" | tr -d '\n' | sed 's/"/\\"/g')

  local event_date=$(date +%Y-%m-%d)

  CREATE_RESPONSE=$(curl -s -X POST "$BASE_URL/api/admin/events" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d "{
      \"event_type\": \"other\",
      \"event_name\": \"$name\",
      \"event_date\": \"$event_date\",
      \"customer_name\": \"Test User\",
      \"customer_email\": \"test@example.com\",
      \"admin_email\": \"admin@example.com\",
      \"password\": \"MasonryTest2026!\",
      \"welcome_message\": \"$description\",
      \"color_theme\": \"$color_theme_escaped\",
      \"expiration_days\": 30
    }")

  local event_id=$(echo "$CREATE_RESPONSE" | grep -o '"id":[0-9]*' | head -1 | cut -d':' -f2)
  local slug=$(echo "$CREATE_RESPONSE" | grep -o '"slug":"[^"]*"' | cut -d'"' -f4)
  local share_link=$(echo "$CREATE_RESPONSE" | grep -o '"share_link":"[^"]*"' | cut -d'"' -f4)

  if [ -z "$event_id" ]; then
    echo "  Failed to create gallery. Response: $CREATE_RESPONSE"
    return 1
  fi

  echo "  Created event ID: $event_id, slug: $slug"
  echo "  Share link: $share_link"

  # Upload test images
  echo "  Uploading test images..."

  for img in "$TEST_IMAGES_DIR"/*.jpg; do
    if [ -f "$img" ]; then
      local filename=$(basename "$img")
      curl -s -X POST "$BASE_URL/api/admin/photos/$event_id/upload" \
        -H "Authorization: Bearer $TOKEN" \
        -F "photos=@$img" > /dev/null
      echo "    Uploaded: $filename"
    fi
  done

  echo "  Gallery URL: $share_link"
  echo "$share_link" >> /tmp/masonry_test_galleries.txt
}

# Clear previous results
> /tmp/masonry_test_galleries.txt

# Create galleries for each masonry mode
create_gallery "Masonry Columns Test" "columns" "Pinterest-style vertical columns with varied heights based on photo aspect ratios"
create_gallery "Masonry Rows Test" "rows" "Custom row-based justified layout that fills each row completely"
create_gallery "Masonry Flickr Test" "flickr" "Flickr's justified-layout algorithm for optimal row arrangement"
create_gallery "Masonry Quilted Test" "quilted" "Mixed sizes layout - landscape photos span 2 columns, portraits span 2 rows"

echo ""
echo "=== All Test Galleries Created ==="
echo ""
echo "Gallery URLs:"
cat /tmp/masonry_test_galleries.txt
echo ""
echo "You can also find these URLs in /tmp/masonry_test_galleries.txt"
