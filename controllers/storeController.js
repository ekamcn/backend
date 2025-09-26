const prisma = require("../prisma/prisma");
const { GraphQLClient } = require("graphql-request");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const pty = require("node-pty");
const os = require("os");

/**
 * Get store details by store name
 * @param {string} store_name
 * @returns {Promise<object>} Store details or error object
 */
async function getStoreByName(req, res) {
  await prisma.$connect();
  try {
    const { storeName: store_name } = req.query;
    // Input validation
    if (!store_name || typeof store_name !== "string" || !store_name.trim()) {
      return res
        .status(400)
        .json({ error: "Missing or invalid store_name parameter." });
    }
    // Query the store by name (case-insensitive)
    const store = await prisma.stores.findFirst({
      where: {
        storeName: {
          equals: store_name,
        },
      },
    });
    if (!store) {
      return res.status(404).json({ error: "Store not found." });
    }
    // Return store details (omit sensitive fields if any)
    return res.json({ store });
  } catch (error) {
    console.error("Error fetching store details:", error);
    return res.status(500).json({ error: "Internal server error." });
  }
}

/**
 * Delete store by store name
 * @param {Request} req
 * @param {Response} res
 */
async function deleteStoreByName(req, res) {
  await prisma.$connect();
  try {
    const { storeName: store_name } = req.query;
    const themeDir = path.resolve("./public",store_name.trim());
    // Input validation
    if (!store_name || typeof store_name !== "string" || !store_name.trim()) {
      return res
        .status(400)
        .json({ error: "Missing or invalid store_name parameter." });
    }
    // Check if store exists
    const store = await prisma.stores.findFirst({
      where: {
        storeName: store_name,
      },
    });
    if (!store) {
      return res.status(404).json({ error: "Store not found." });
    }
    // Delete the store
    await prisma.stores.delete({
      where: { store_id: store.store_id },
    });
    
    if (fs.existsSync(themeDir)) {
      try {
        fs.rmSync(themeDir, { recursive: true, force: true });
      } catch (err) {
        console.error("Error deleting theme directory:", err);
        // Optionally, you can return a warning but not fail the API
      }
    }
    return res.json({ message: "Store deleted successfully." });
  } catch (error) {
    console.error("Error deleting store:", error);
    return res.status(500).json({ error: "Internal server error." });
  }
}

async function getAllStores(req, res) {
  await prisma.$connect();
  const stores = await prisma.stores.findMany();
  if (!stores) {
    return res.status(400).json({ error: "No stores found." });
  }
  return res.status(200).json({ stores });
}

/**
 * Get environment variables for a store by reading its .env file
 * Returns keys matching the create-store payload (without base64 data)
 */
async function getStoreEnvByName(req, res) {
  try {
    const { storeName } = req.query;
    if (!storeName || typeof storeName !== "string" || !storeName.trim()) {
      return res
        .status(400)
        .json({ error: "Missing or invalid storeName parameter." });
    }

    const themeDir = path.resolve("./" + storeName);
    const envPath = path.join(themeDir, ".env");
    if (!fs.existsSync(envPath)) {
      return res
        .status(404)
        .json({ error: ".env not found for the given store." });
    }

    const content = fs.readFileSync(envPath, "utf8");
    const env = {};
    content.split(/\r?\n/).forEach((line) => {
      if (!line || line.trim().startsWith("#")) return;
      const eqIndex = line.indexOf("=");
      if (eqIndex === -1) return;
      const key = line
        .slice(0, eqIndex)
        .trim()
        .replace(/^export\s+/, "");
      let value = line.slice(eqIndex + 1).trim();
      value = value ? value.replace(/^"|"$/g, "") : "";
      if (key) env[key] = value;
    });

    // Normalize discover collections into an array
    let discoverCollectionsArray = [];
    if (env.VITE_DISCOVER_OUR_COLLECTIONS) {
      const raw = env.VITE_DISCOVER_OUR_COLLECTIONS;
      try {
        const maybeJson = JSON.parse(raw);
        if (Array.isArray(maybeJson)) {
          discoverCollectionsArray = maybeJson
            .filter((v) => typeof v === "string" && v.trim())
            .map((v) => v.trim());
        } else if (typeof maybeJson === "string") {
          discoverCollectionsArray = maybeJson
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean);
        }
      } catch (_) {
        // Fallback: treat as comma-separated list
        discoverCollectionsArray = String(raw)
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean);
      }
    }

    // Map back to the creation payload shape
    const payload = {
      name: env.VITE_SHOPIFY_STORE_NAME || storeName.trim(),
      email: env.VITE_CUSTOMER_SUPPORT_EMAIL || "",
      phone: env.VITE_CUSTOMER_SERVICE_PHONE || "",
      domainName: env.VITE_DOMAIN_NAME || "",
      shopifyUrl: env.VITE_SHOPIFY_URL || env.VITE_DOMAIN_NAME,
      shopifyEmail: env.VITE_SHOPIFY_EMAIL || "",
      shopifyAdminToken: env.VITE_SHOPIFY_ADMIN_ACCESS_TOKEN || "",
      companyName: env.VITE_COMPANY_NAME || "",
      companyAddress: env.VITE_COMPANY_ADDRESS || "",
      storeTitle: env.VITE_STORE_TITLE || "",
      discoverOurCollections: discoverCollectionsArray,
      companyBusinessNumber: env.VITE_SIREN_NUMBER || "",
      policyUpdatedAt: env.VITE_PP_LAST_UPDATED_DATE || "",
      businessHours: env.VITE_BUSINESS_HOURS || "",
      refundPeriod: env.VITE_REFUND_PERIOD || "",
      refundProcessingTime: env.VITE_REFUND_PROCESSING_TIME || "",
      deliveryProvider: env.VITE_DELIVERY_PROVIDER || "",
      deliveryAreas: env.VITE_DELIVERY_AREAS || "",
      orderProcessingTime: env.VITE_ORDER_PROCESSING_TIME || "",
      standardDeliveryTime: env.VITE_STANDARD_DELIVERY_TIME || "",
      returnPeriod: env.VITE_RETURN_PERIOD || "",
      supportHours: env.VITE_SUPPORT_HOURS || "",
      withdrawalPeriod: env.VITE_WITHDRAWAL_PERIOD || "",
      returnShippingPolicy: env.VITE_RETURN_SHIPPING_POLICY || "",
      saleItemsPolicy: env.VITE_SALE_ITEMS_POLICY || "",
      termsOfServiceUpdateAt: env.VITE_TC_LAST_UPDATED_DATE || "",
      companyCity: env.VITE_COMPANY_CITY || "",
    };

    return res.status(200).json({ success: true, data: payload });
  } catch (error) {
    console.error("Error reading store env:", error);
    return res
      .status(500)
      .json({ success: false, error: "Internal server error." });
  }
}

/**
 * Update Google Ads ID and Synchronis ID for a store
 * @param {Request} req
 * @param {Response} res
 */
async function updateGoogleScripts(req, res) {
  await prisma.$connect();
  try {
    const { storeId, googleAdsId, synchronisId } = req.body;

    if (!storeId) {
      return res.status(400).json({
        success: false,
        message: "Store ID is required",
      });
    }

    if (!googleAdsId && !synchronisId) {
      return res.status(400).json({
        success: false,
        message: "At least one of Google Ads ID or Synchronis ID is required",
      });
    }

    const existingStore = await prisma.stores.findUnique({
      where: {
        store_id: storeId,
      },
    });

    if (!existingStore) {
      return res.status(404).json({
        success: false,
        message: "Store not found",
      });
    }

    const updatedStore = await prisma.stores.update({
      where: {
        store_id: storeId,
      },
      data: {
        googleAdsId: googleAdsId || null,
        synchronisId: synchronisId || null,
        updated_at: new Date(),
      },
    });
    const storeName = updatedStore.storeName || existingStore.storeName;
    if (storeName && typeof storeName === "string" && storeName.trim()) {
      const themeDir = path.resolve("./" + storeName.trim());
      const envPath = path.join(themeDir, ".env");

      if (fs.existsSync(themeDir)) {
        let content = "";
        if (fs.existsSync(envPath)) {
          content = fs.readFileSync(envPath, "utf8");
        }

        const upsertEnvVar = (src, key, value) => {
          if (value === undefined || value === null || value === "") return src;
          const escapedKey = key
            ? key.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")
            : "";
          const regex = new RegExp(`(^|\n)\s*${escapedKey}\s*=.*(?=\n|$)`);
          const line = `${key}="${String(value).trim()}"`;
          if (regex.test(src)) {
            return src ? src.replace(regex, (m, p1) => `${p1}${line}`) : src;
          }
          if (!src.endsWith("\n") && src.length > 0) src += "\n";
          return src + line + "\n";
        };

        let nextContent = content;
        nextContent = upsertEnvVar(
          nextContent,
          "VITE_GOOGLE_ADS_ID",
          googleAdsId
        );
        nextContent = upsertEnvVar(
          nextContent,
          "VITE_SYNCHRONIS_ID",
          synchronisId
        );

        if (nextContent !== content) {
          fs.writeFileSync(envPath, nextContent, "utf8");
        }
      }

      // After updating env, link to the same storefront name and deploy
      try {
        await hydrogenLinkAndDeploy(themeDir, storeName.trim());
      } catch (deployError) {
        return res.status(500).json({
          success: false,
          message: "Failed to link and deploy Hydrogen storefront",
          error: deployError.message,
          cliOutput: deployError.cliOutput || "No CLI output captured",
        });
      }
    }

    res.status(200).json({
      success: true,
      message: "Google scripts updated successfully",
      data: {
        storeId: updatedStore.store_id,
        storeName: updatedStore.storeName,
        googleAdsId: updatedStore.googleAdsId,
        synchronisId: updatedStore.synchronisId,
      },
    });
  } catch (error) {
    console.error("Error updating google scripts:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
}

// Retry command with exponential backoff
async function retryCommand(command, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await command();
    } catch (error) {
      if (i < retries - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, delay * Math.pow(2, i))
        );
        console.log(`Retrying command, attempt ${i + 2}/${retries}`);
      } else {
        throw error;
      }
    }
  }
}

// Link hydrogen project to the given storefront and deploy
function hydrogenLinkAndDeploy(themeDir, storefrontName) {
  return new Promise((resolve, reject) => {
    try {
      console.log("Linking Hydrogen project:", { themeDir, storefrontName });
      execSync("shopify auth logout", { stdio: "ignore" });

      const shell = os.platform() === "win32" ? "powershell.exe" : "zsh";
      const ptyProcess = pty.spawn(
        "shopify",
        ["hydrogen", "link", "--path", themeDir],
        {
          name: "xterm-256color",
          cwd: themeDir,
          env: process.env,
          cols: 80,
          rows: 30,
        }
      );

      let cliOutput = "";
      let storefrontBuffer = null;
      let selectingStorefront = false;
      let navInterval = null;
      ptyProcess.onData((data) => {
        cliOutput += data;
        console.log("PTY Link Output:", data);

        if (
          data.includes("Press any key to open the login page on your browser")
        ) {
          setTimeout(() => {
            ptyProcess.write("\r");
          }, 500);
        }

        if (data.includes("Opened link to start the auth process")) {
          console.debug("\nAUTH-URL");

          const authUrl = data.match(
            /https:\/\/accounts\.shopify\.com\/activate-with-code\?device_code%5Buser_code%5D=[A-Z0-9\-]+/
          );
          if (authUrl) {
            console.log("Auth URL:", authUrl[0]);
            return authUrl;
          }
        }

        if (data.includes("Your project is currently linked")) {
          setTimeout(() => {
            ptyProcess.write("\r");
          }, 500);
        }

        if (
          data.includes(
            "Do you want to link to a different Hydrogen storefront"
          )
        ) {
          setTimeout(() => {
            ptyProcess.write("y\r");
          }, 500);
        }

        if (
          data.includes(
            "Do you want to link to a different Hydrogen storefront"
          )
        ) {
          console.debug("CONFIRM-PROMPT detected");
          setTimeout(() => {
            ptyProcess.write("y\r"); // always confirm → can adjust later
          }, 200);
          return;
        }

        // Step 2: Confirm echo
        if (data.includes("✔  Yes, confirm")) {
          console.debug("CONFIRM-ACK received");
          return; // nothing else here
        }

        // Step 3: Storefront selection
        // --- Step 3: Storefront selection ---
        if (data.includes("?  Select a Hydrogen storefront to link:")) {
          if (selectingStorefront) return; // already handling
          console.debug("STORE-LIST detected");
          storefrontBuffer = "";
        }

        if (storefrontBuffer !== null) {
          storefrontBuffer += data;

          if (storefrontBuffer.includes("Press ↑") && !selectingStorefront) {
            selectingStorefront = true;

            const noAnsi = storefrontBuffer
              ? storefrontBuffer.replace(/\x1b\[[0-9;]*m/g, "")
              : "";
            const lines = noAnsi
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean);

            // capture all options (including "Create a new storefront")
            const storefrontOptions = lines.filter(
              (line) =>
                /(https?:\/\/[^\s]+)/.test(line) ||
                /Create a new storefront/i.test(line)
            );

            // normalize
            const normalizedOptions = storefrontOptions.map((l) =>
              l
                ? l
                    .replace(/^❯?\s*/, "")
                    .replace(/\s+\[default\]$/, "")
                    .trim()
                : ""
            );

            const targetStorefront = storefrontName.trim().toLowerCase();

            // find target index (match name or URL fragment, case-insensitive)
            let targetIndex = normalizedOptions.findIndex((opt) =>
              opt.toLowerCase().includes(targetStorefront)
            );

            if (targetIndex === -1) {
              console.warn(
                `⚠️ Storefront "${targetStorefront}" not found. Defaulting to first available (not 'Create a new storefront').`
              );
              // default to first *real* storefront, skip "create new"
              targetIndex = normalizedOptions.findIndex(
                (opt) => !/create a new storefront/i.test(opt)
              );
              if (targetIndex === -1) targetIndex = 0; // fallback
            }

            // detect which storefront is currently selected
            const cursorLineIndex = storefrontOptions.findIndex((l) =>
              l.includes("❯")
            );
            let currentIndex = cursorLineIndex === -1 ? 0 : cursorLineIndex;

            // safeguard: never auto-pick "Create a new storefront" unless that's the target
            if (
              /create a new storefront/i.test(normalizedOptions[targetIndex])
            ) {
              console.warn(
                "⚠️ Resolved target is 'Create a new storefront'. Skipping selection."
              );
              storefrontBuffer = null;
              selectingStorefront = false;
              return;
            }

            // already correct → just Enter
            if (
              normalizedOptions[currentIndex] &&
              normalizedOptions[currentIndex]
                .toLowerCase()
                .includes(targetStorefront)
            ) {
              setTimeout(() => {
                ptyProcess.write("\r");
                storefrontBuffer = null;
                selectingStorefront = false;
              }, 200);
              return;
            }

            // otherwise, navigate
            let steps = 0;
            const totalSteps = targetIndex - currentIndex; // 🔥 removed +1 bug

            navInterval = setInterval(() => {
              if (steps < Math.abs(totalSteps)) {
                ptyProcess.write(totalSteps > 0 ? "\x1B[B" : "\x1B[A");
                steps++;
              } else {
                ptyProcess.write("\r"); // Enter
                clearInterval(navInterval);
                navInterval = null;
                storefrontBuffer = null;
                selectingStorefront = false;
              }
            }, 150);
          }
        }

        // Step 4: Storefront echo
        if (
          data.includes("✔") &&
          data.includes("Select a Hydrogen storefront")
        ) {
          console.debug("STORE-LINK CONFIRMED");
        }

        // --- Extra cases ---
        if (data.includes("is now linked")) {
          if (navInterval) {
            clearInterval(navInterval);
            navInterval = null;
          }
          selectingStorefront = false;
          storefrontBuffer = null;
        }

        if (data.includes("Your project is currently linked")) {
          setTimeout(() => {
            ptyProcess.write("\r"); // accept existing
          }, 300);
        }

        if (data.includes("Could not create storefront")) {
          const noAnsi = data ? data.replace(/\x1b\[[0-9;]*m/g, "") : "";
          const messageLines = noAnsi
            .split("\n")
            .map((line) => line.trim())
            .filter(
              (line) =>
                line &&
                !/^[-─╭╰╮╯│]+$/.test(line) &&
                !/^╭.*╮$/.test(line) &&
                !/^╰.*╯$/.test(line)
            )
            .map((line) =>
              line ? line.replace(/^│/, "").replace(/│$/, "").trim() : ""
            );
          const finalMessage = messageLines.join(" ");
        }
      });

      ptyProcess.onExit(({ exitCode, signal }) => {
        console.log("PTY Link Exit:", { exitCode, signal });
        if (exitCode === 0) {
          retryCommand(() => hydrogenDeploy(themeDir))
            .then(resolve)
            .catch((error) => {
              error.cliOutput = cliOutput;
              reject(error);
            });
        } else {
          const error = new Error(
            `Hydrogen link failed with exit code ${exitCode}`
          );
          error.cliOutput = cliOutput;
          reject(error);
        }
      });
    } catch (error) {
      error.cliOutput = cliOutput || "No CLI output captured";
      console.error("Link Error:", error);
      reject(error);
    }
  });
}

function hydrogenDeploy(themeDir) {
  return new Promise((resolve, reject) => {
    try {
      const shell = os.platform() === "win32" ? "powershell.exe" : "zsh";
      const ptyProcess = pty.spawn(shell, [], {
        name: "xterm-color",
        cwd: themeDir,
        env: process.env,
        cols: 80,
        rows: 30,
      });

      let cliOutput = "";
      ptyProcess.write(
        `shopify hydrogen deploy --path "${themeDir}" --force\n`
      );

      ptyProcess.onData((data) => {
        cliOutput += data;
        console.log("PTY Deploy Output:", data);

        if (data.includes("?  Select an environment to deploy to:")) {
          setTimeout(() => {
            ptyProcess.write("\x1B[B");
            setTimeout(() => {
              ptyProcess.write("\r");
            }, 500);
          }, 500);
        }

        if (data.includes("Creating a deployment against Production")) {
          setTimeout(() => {
            ptyProcess.write("\x1B[A");
            setTimeout(() => {
              ptyProcess.write("\r");
            }, 500);
          }, 500);
        }
      });

      ptyProcess.onExit(({ exitCode, signal }) => {
        console.log("PTY Deploy Exit:", { exitCode, signal });
        if (exitCode === 0) {
          resolve();
        } else {
          const error = new Error(
            `Hydrogen deployment failed with exit code ${exitCode}`
          );
          error.cliOutput = cliOutput;
          reject(error);
        }
      });
    } catch (error) {
      error.cliOutput = cliOutput || "No CLI output captured";
      console.error("Deploy Error:", error);
      reject(error);
    }
  });
}

/**
 * Get publication ID by store name from Shopify GraphQL
 * @param {Request} req
 * @param {Response} res
 */
async function getPublicationByStoreName(req, res) {
  try {
    const { storeName } = req.query;

    // Input validation
    if (!storeName || typeof storeName !== "string" || !storeName.trim()) {
      return res.status(400).json({
        success: false,
        error: "Missing or invalid storeName parameter.",
      });
    }

    // Check if we have the required environment variables
    const shopifyDomain = process.env.SHOPIFY_DOMAIN;
    const shopifyAccessToken = process.env.SHOPIFY_ACCESS_TOKEN;

    if (!shopifyDomain || !shopifyAccessToken) {
      return res.status(500).json({
        success: false,
        error:
          "Shopify configuration missing. Please set SHOPIFY_DOMAIN and SHOPIFY_ACCESS_TOKEN environment variables.",
      });
    }

    // Create GraphQL client
    const client = new GraphQLClient(shopifyDomain, {
      headers: {
        "X-Shopify-Access-Token": shopifyAccessToken,
      },
    });

    // GraphQL query to fetch publications
    const query = `
      query {
        publications(first: 250) {
          edges {
            node {
              id
              name
            }
          }
        }
      }
    `;

    // Execute the GraphQL query
    const data = await client.request(query);

    if (!data.publications || !data.publications.edges) {
      return res.status(404).json({
        success: false,
        error: "No publications found",
      });
    }

    // Find publication that matches the store name
    const matchingPublication = data.publications.edges.find((edge) => {
      const publicationName = edge.node.name.toLowerCase();
      const searchStoreName = storeName
        .toLowerCase()
        .split(/[-\s]+/)
        .filter(Boolean)
        .join(" ");

      // Check for exact match or if store name is contained in publication name
      return (
        publicationName === searchStoreName ||
        publicationName.includes(searchStoreName) ||
        searchStoreName.includes(publicationName)
      );
    });

    if (!matchingPublication) {
      return res.status(404).json({
        success: false,
        error: `No publication found matching store name: ${storeName}`,
        availablePublications: data.publications.edges.map((edge) => ({
          id: edge.node.id,
          name: edge.node.name,
          handle: edge.node.handle,
        })),
      });
    }

    // Return the matching publication
    return res.json({
      success: true,
      publication: {
        id: matchingPublication.node.id,
        name: matchingPublication.node.name,
        handle: matchingPublication.node.handle,
      },
      storeName: storeName,
    });
  } catch (error) {
    console.error("Error fetching publication:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error while fetching publication",
      details: error.message,
    });
  }
}

module.exports = {
  getStoreByName,
  deleteStoreByName,
  getAllStores,
  updateGoogleScripts,
  getPublicationByStoreName,
  getStoreEnvByName,
};
