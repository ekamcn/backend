# Publications API Documentation

## Get Publication by Store Name

This API endpoint fetches publications from Shopify GraphQL and matches them with a provided store name.

### Endpoint
```
GET /store/publication
```

### Query Parameters
- `storeName` (required): The name of the store to search for in publications

### Environment Variables Required
- `SHOPIFY_DOMAIN`: Your Shopify store domain (e.g., "your-store.myshopify.com")
- `SHOPIFY_ACCESS_TOKEN`: Your Shopify Admin API access token

### Example Request
```bash
curl "http://localhost:3000/store/publication?storeName=My%20Store%20Name"
```

### Example Response (Success)
```json
{
  "success": true,
  "publication": {
    "id": "gid://shopify/Publication/123456789",
    "name": "My Store Name",
    "handle": "my-store-name"
  },
  "storeName": "My Store Name"
}
```

### Example Response (Not Found)
```json
{
  "success": false,
  "error": "No publication found matching store name: My Store Name",
  "availablePublications": [
    {
      "id": "gid://shopify/Publication/123456789",
      "name": "Another Store",
      "handle": "another-store"
    }
  ]
}
```

### Example Response (Error)
```json
{
  "success": false,
  "error": "Missing or invalid storeName parameter."
}
```

### Error Codes
- `400`: Missing or invalid storeName parameter
- `404`: No publication found matching the store name
- `500`: Internal server error or missing Shopify configuration

### Notes
- The API performs case-insensitive matching
- It checks for exact matches, partial matches, and reverse partial matches
- If no exact match is found, it returns all available publications for reference
- Make sure to set the required environment variables before using the API 