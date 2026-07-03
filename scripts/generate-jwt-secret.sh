#!/bin/bash

# Generate a secure JWT secret for PicPeak

echo "==================================="
echo "JWT Secret Generator for PicPeak"
echo "==================================="
echo ""

# Generate the secret
SECRET=$(openssl rand -hex 32)

echo "Your new JWT secret (64 characters):"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "$SECRET"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "To use this secret:"
echo ""
echo "1. For Docker Compose (.env file):"
echo "   JWT_SECRET=$SECRET"
echo ""
echo "2. For environment variable:"
echo "   export JWT_SECRET=$SECRET"
echo ""
echo "3. For systemd service:"
echo "   Environment=\"JWT_SECRET=$SECRET\""
echo ""
echo "⚠️  IMPORTANT:"
echo "   - Keep this secret secure and never commit it to version control"
echo "   - Use different secrets for different environments"
echo "   - Store production secrets in a secure secret management system"
echo "   - Rotate secrets regularly (every 90 days recommended)"
echo ""