const os = require("os");
const path = require("path");
const fs = require("node:fs");
const { PrismaClient } = require("./generated/prisma");
const prisma = new PrismaClient();

const { execSync } = require("child_process");
const pty = require("node-pty");
const sharp = require("sharp");

const shell = os.platform() === "win32" ? "powershell.exe" : "bash";

var themeDir = null;
var themeEnv = "";

module.exports = (io, socket) => {
  socket.on("shopify:create", async (message, logoData) => {
    await prisma.$connect();
    // Review payload and verify
    try {
      var message = JSON.parse(message);
    } catch (error) {
      console.error("Payload parsing error occured", error.message);
      socket.emit("shopify:failure", "Invalid Payload");
      return;
    }
    if (!message.name) {
      socket.emit("shopify:failure", "Name Missing");
      return;
    }
    const nameRegex = /^[a-zA-Z][a-zA-Z0-9 ]*$/;
    if (!nameRegex.test(message.name)) {
      socket.emit("shopify:failure", "Name Invalid");
      return;
    }

    if (!message.email) {
      socket.emit("shopify:failure", "Email Missing");
      return;
    }
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (!emailRegex.test(message.email)) {
      socket.emit("shopify:failure", "Email Invalid");
      return;
    }
    if (!message.phone) {
      socket.emit("shopify:failure", "Phone Missing");
      return;
    }
    let storeDetails = null;
    const storeExists = await prisma.stores.findFirst({
      where: {
        storeName: message.name.trim(),
      },
    });
    if (storeExists && storeExists.status === "active") {
      socket.emit("shopify:failure", "Store Already Exists");
      return;
    }
    await prisma.stores.create({
      data: {
        storeName: message.name.trim(),
        email: message.email.trim(),
        phone: message.phone.trim(),
        storeUrl: null,
        status: "pending",
        customOfferIds: message.customOfferIds || {},
      },
    });
    // Fetch the store details once after creation
    storeDetails = await prisma.stores.findFirst({
      where: {
        storeName: message.name.trim(),
      },
    });
    if (!message.logoName) {
      socket.emit("shopify:failure", "LogoName Missing");
      return;
    }
    const logoExts = [".jpg", ".jpeg", ".png", ".gif"];
    if (!logoExts.includes(path.extname(message.logoName).toLowerCase())) {
      socket.emit("shopify:failure", "LogoName Invalid");
      return;
    }
    if (!message.logoType) {
      socket.emit("shopify:failure", "LogoType Missing");
      return;
    }
    const logoTypes = ["image/jpeg", "image/png", "image/gif"];
    if (!logoTypes.includes(message.logoType)) {
      socket.emit("shopify:failure", "LogoType Invalid");
      return;
    }
    // Function to process image data
    const processImageData = (imageData, imageName) => {
      if (!imageData) {
        console.log(`${imageName} is not provided`);
        return null;
      }

      try {
        let base64Data = imageData;
        let detectedType = null;

        // Handle data URI format (e.g., "data:image/png;base64,...")
        if (imageData?.includes(",")) {
          const matches = imageData.match(
            /^data:image\/([a-zA-Z0-9\+]+);base64,(.+)$/
          );
          if (!matches || matches.length !== 3) {
            throw new Error(`Invalid base64 image format for ${imageName}`);
          }
          base64Data = matches[2];
        }
        // If no comma found, assume it's raw base64 data

        // Convert to buffer
        const imageBuffer = Buffer.from(base64Data, "base64");

        // File size limit check (50MB)
        const imageSizeLimit = 50 * 1024 * 1024;
        if (imageBuffer.byteLength > imageSizeLimit) {
          throw new Error(`${imageName} is too Large`);
        }

        console.log(
          `${imageName} buffer size:`,
          imageBuffer.byteLength,
          "bytes"
        );

        detectedType = imageName.split(".").pop();
        console.log(`${imageName} detected type:`, detectedType);

        return { buffer: imageBuffer, type: detectedType };
      } catch (error) {
        console.error(`${imageName} processing error:`, error);
        throw error;
      }
    };

    // Process all three images
    let logoInfo = null;
    let bannerInfo = null;
    let squareInfo = null;
    let mobileBanner = null;

    try {
      logoInfo = processImageData(
        logoData?.base64 ?? logoData,
        logoData?.fileName ?? "logo"
      );
      bannerInfo = processImageData(
        message?.banner?.base64 ?? message?.banner,
        message?.banner?.fileName ?? "banner"
      );
      squareInfo = processImageData(
        message?.squareLogo?.base64 ?? message?.squareLogo,
        message?.squareLogo?.fileName ?? "square"
      );
      mobileBanner = processImageData(
        message?.mobileBanner?.base64 ?? message?.mobileBanner,
        message?.mobileBanner?.fileName ?? "mobileBanner"
      );
    } catch (error) {
      socket.emit("shopify:failure", error.message);
      return;
    }

    // Note: Banner and square images will be saved directly to the theme's public directory in hydrogenPrepare function
    socket.emit("shopify:status", "Images Processed Successfully");

    // Prepare theme directory
    themeDir = path.resolve("./" + message.name.trim());
    themeDirOriginal = path.resolve(
      `./${message.category}_${message.language}`
    );
    const hyphenatedStoreName = message.name
      .trim()
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9\-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");
    themeEnv = `
#Custom theme configuration
VITE_SHOPIFY_STORE_NAME="${message.name.trim()}"
VITE_SHOPIFY_STORE_EMAIL="${message.email.trim()}"
VITE_SHOPIFY_STORE_PHONE="${message.phone.trim()}"
VITE_SHOPIFY_STORE_LANGUAGE=['en','fr','de']
VITE_STORE_TITLE="${message?.storeTitle}"


VITE_LOGO="/${logoData?.fileName}"
VITE_BANNER="/${message?.banner?.fileName}"
VITE_SQUARE_LOGO="/${message?.squareLogo?.fileName}"
VITE_MOBILE_BANNER="/${message?.mobileBanner?.fileName}"

# Store Basics
VITE_STORE_NAME="${hyphenatedStoreName}"
VITE_CUSTOMER_SUPPORT_EMAIL="${message.email.trim()}"
VITE_CUSTOMER_SERVICE_PHONE="${message.phone.trim()}"
VITE_DOMAIN_NAME="${message.domainName || ""}"
VITE_SHOPIFY_URL="${message.shopifyUrl || ""}"
VITE_SHOPIFY_EMAIL="${message.shopifyEmail || ""}"
VITE_SHOPIFY_ADMIN_ACCESS_TOKEN="${message.shopifyAdminToken || ""}"

#new data
VITE_SIREN_NUMBER="${message.companyBusinessNumber || ""}"
VITE_PP_LAST_UPDATED_DATE="${message.policyUpdatedAt || ""}"
VITE_BUSINESS_HOURS="${message.businessHours || ""}"
VITE_REFUND_PERIOD="${message.refundPeriod || ""}"
VITE_REFUND_PROCESSING_TIME="${message.refundProcessingTime || ""}"

VITE_DELIVERY_PROVIDER="${message.deliveryProvider}"
VITE_DELIVERY_AREAS="${message.deliveryAreas}"
VITE_ORDER_PROCESSING_TIME="${message.orderProcessingTime}"
VITE_STANDARD_DELIVERY_TIME="${message.standardDeliveryTime}"
VITE_RETURN_PERIOD="${message.returnPeriod}"
VITE_SUPPORT_HOURS="${message.supportHours}"
VITE_WITHDRAWAL_PERIOD="${message.withdrawalPeriod}"
VITE_RETURN_SHIPPING_POLICY="${message.returnShippingPolicy}"
VITE_SALE_ITEMS_POLICY="${message.saleItemsPolicy}"
VITE_TC_LAST_UPDATED_DATE="${message.termsOfServiceUpdateAt}"


# Theme Selection
VITE_CATEGORY="${message.category || "general"}"
VITE_LANGUAGE="${message.language || "en"}"

# Brand Customization
VITE_COLOR1="${message.primaryColor || "#000000"}"
VITE_FOOTER_COLOR=${message?.footerColor || "#ffffff"}
VITE_COLOR2="${message.secondaryColor || "#ffffff"}"
VITE_TYPOGRAPHY="${message.typography || "sans-serif"}"

# Legal Information
VITE_COMPANY_NAME="${message.companyName || ""}"
VITE_COMPANY_ADDRESS="${message.companyAddress || ""}"

# Checkout Configuration
VITE_CHECKOUT_DOMAIN="${message.checkoutDomain || ""}"
VITE_CHECKOUT_ID="${message.checkoutId || ""}"
VITE_OFFER_ID_TYPE="${message.offerIdType || "default"}"

VITE_DISCOVER_OUR_COLLECTIONS=${message?.discoverOurCollections || []}
`;

    // Append dynamic Custom Offer IDs to the env
    try {
      const customOfferIds = message.customOfferIds || {};
      if (customOfferIds && typeof customOfferIds === "object") {
        const normalizeKey = (k) =>
          String(k)
            .trim()
            .replace(/\s+/g, "")
            .replace(/\./g, "_")
            .replace(/[^0-9_]/g, "");
        const lines = Object.entries(customOfferIds)
          .filter(([k, v]) => k !== undefined && v !== undefined && v !== null)
          .map(
            ([k, v]) => `VITE_CUSTOM_OFFER_ID_${normalizeKey(k)}="${String(v)}"`
          );
        if (lines.length > 0) {
          themeEnv += lines.join("\n") + "\n";
        }
      }
    } catch (e) {
      console.warn("Failed to append custom offer ids to env", e);
    }

    // Copy Hydrogen based on name
    const ptyProcess0 = pty.spawn(shell, [], {
      name: "xterm-color",
      cols: 80,
      rows: 30,
      cwd: process.cwd(),
      env: process.env,
    });
    ptyProcess0.on("data", function (data) {
      process.stdout.write(data); // Optional: see the CLI output
    });
    ptyProcess0.write(`cp -r "${themeDirOriginal}" "${themeDir}"\n`);
    ptyProcess0.write(`rm -rf "${themeDir}/node_modules"\n`);
    ptyProcess0.write(`exit\n`);

    ptyProcess0.onExit(({ exitCode, signal }) => {
      //console.log(`\nProcess exited with code ${exitCode}, signal: ${signal}`);
      if (exitCode === 0) {
        console.log("✅ Hydrogen theme copied successfully");
        socket.emit("shopify:status", "Hydrogen Copy Successful");

        hydrogenPrepare(themeDir, themeEnv);
      } else {
        console.log("❌ Hydrogen theme copy failed");
        socket.emit("shopify:failure", "Hydrogen Copy Failure");
        finalizeProcess(themeDir, true); // Cleanup on error, delete store
      }
    });

    // Prepare hydrogen theme npm+git
    // const themeDir = '/Users/ekamjitsingh/Downloads/shopify_hydrogen_automate/clothestheme'
    // const themeEnv = `\n#Custom theme configuration\nVITE_SHOPIFY_STORE_NAME="clothestheme"\nVITE_SHOPIFY_STORE_EMAIL="clothes@test.com"\nVITE_SHOPIFY_STORE_PHONE="7009338940"\nVITE_SHOPIFY_STORE_LANGUAGE=['en','fr','de'];\nVITE_SHOPIFY_STORE_LOGO="/logo.png"`

    function hydrogenPrepare(themeDir, themeEnv) {
      try {
        // Ensure public directory exists
        const publicDir = path.join(themeDir, "public");
        if (!fs.existsSync(publicDir)) {
          fs.mkdirSync(publicDir, { recursive: true });
        }

        // Function to save image to theme's public directory (preserve original as-is)
        const saveImageToTheme = (imageInfo, fileName, imageName) => {
          if (!imageInfo) {
            console.log(`${imageName} not provided, skipping...`);
            return Promise.resolve();
          }

          return new Promise((resolve, reject) => {
            try {
              const imagePath = path.join(publicDir, fileName);
              // Always save the original buffer without re-encoding to preserve formats/transparency
              fs.writeFileSync(imagePath, imageInfo.buffer);
              console.log(`${imageName} saved successfully to:`, imagePath);
              resolve();
            } catch (error) {
              console.error(`${imageName} save error:`, error);
              reject(error);
            }
          });
        };

        // Save all three images to theme's public directory
        const savePromises = [];

        // Save logo
        if (logoInfo) {
          const logoFileName = logoData?.fileName ?? "logo.jpg";
          savePromises.push(saveImageToTheme(logoInfo, logoFileName, "Logo"));
        }

        // Save banner
        if (bannerInfo) {
          const bannerFileName = message?.banner?.fileName ?? "banner.jpg";
          savePromises.push(
            saveImageToTheme(bannerInfo, bannerFileName, "Banner")
          );
        }

        // Save square logo
        if (squareInfo) {
          const squareFileName = message?.squareLogo?.fileName ?? "square.jpg";
          savePromises.push(
            saveImageToTheme(squareInfo, squareFileName, "Square Logo")
          );
        }

        if (mobileBanner) {
          const mobileBannerName =
            message?.mobileBanner?.fileName ?? "mobileBanner.jpg";
          savePromises.push(
            saveImageToTheme(mobileBanner, mobileBannerName, "Mobile Banner")
          );
        }

        // Wait for all images to be saved before proceeding
        Promise.all(savePromises)
          .then(() => {
            console.log(
              "All images saved successfully to theme's public directory"
            );
            socket.emit("shopify:status", "All Images Save Successful");

            // Continue with theme preparation after images are saved
            fs.appendFileSync(themeDir + "/.env", themeEnv);

            execSync("npm install", { cwd: themeDir });
            execSync("npm run build", { cwd: themeDir });

            execSync("git init", { cwd: themeDir });
            execSync('git config user.name "Test User"', { cwd: themeDir });
            execSync('git config user.email "test@user.user"', {
              cwd: themeDir,
            });
            execSync("git add .", { cwd: themeDir });
            execSync('git commit -m "Auto Commit" || echo "No changes"', {
              cwd: themeDir,
            });

            console.log("✅ Hydrogen theme preparation successful!");
            socket.emit("shopify:status", "Preparation Complete");
            hydrogenLink(themeDir);
          })
          .catch((error) => {
            console.error("Image save error:", error);
            socket.emit("shopify:failure", "Image Save Failure");
            finalizeProcess(themeDir, true);
            return;
          });
      } catch (error) {
        console.error("❌ Hydrogen theme env update failed", error);
        socket.emit("shopify:failure", "Preparation Failed");
        finalizeProcess(themeDir, true); // Cleanup on error, delete store
      }
    }

    // Link hydrogen theme process
    // function hydrogenLink(themeDir) {
    //   try {
    //     execSync("shopify auth logout", {});

    //     const ptyProcess = pty.spawn(
    //       "shopify",
    //       ["hydrogen", "link", "--path", `${themeDir}`],
    //       {
    //         name: "xterm-256color",
    //         cwd: themeDir,
    //         env: process.env,
    //         cols: 80,
    //         rows: 30,
    //       }
    //     );
    //     let urlCaptured = false;

    //     // Helper: if URL wasn't captured during initial link (e.g. first-time creation),
    //     // re-run link to list storefronts, pick the intended one, extract URL, and persist to DB.
    //     const attemptRelinkForUrl = () => {
    //       try {
    //         const relink = pty.spawn(
    //           "shopify",
    //           ["hydrogen", "link", "--path", `${themeDir}`],
    //           {
    //             name: "xterm-256color",
    //             cwd: themeDir,
    //             env: process.env,
    //             cols: 80,
    //             rows: 30,
    //           }
    //         );

    //         relink.onData(async (data) => {
    //           process.stdout.write(data);

    //           // If already linked, accept
    //           if (data.includes("Your project is currently linked")) {
    //             setTimeout(() => relink.write("\r"), 300);
    //             socket.emit("shopify:status", "Link Exists");
    //           }

    //           // Start buffering when storefront selection prompt appears
    //           if (data.includes("?  Select a Hydrogen storefront to link:")) {
    //             if (selectingStorefront) return;
    //             storefrontBuffer = "";
    //           }

    //           if (storefrontBuffer !== null) {
    //             storefrontBuffer += data;

    //             // Wait until hints are present so list is fully rendered
    //             if (storefrontBuffer.includes("Press ↑") && !selectingStorefront) {
    //               selectingStorefront = true;

    //               const noAnsi = storefrontBuffer.replace(/\x1b\[[0-9;]*m/g, "");
    //               const lines = noAnsi
    //                 .split("\n")
    //                 .map((line) => line.trim())
    //                 .filter(Boolean);

    //               const storefrontOptions = lines.filter(
    //                 (line) => /(https?:\/\/[^\s]+)/.test(line) || /Create a new storefront/i.test(line)
    //               );

    //               const normalizedOptions = storefrontOptions.map((l) =>
    //                 l.replace(/^❯?\s*/, "").replace(/\s+\[default\]$/, "").trim()
    //               );

    //               const targetStorefront = (message.storefrontName || message.name)
    //                 .trim()
    //                 .toLowerCase();

    //               let targetIndex = normalizedOptions.findIndex((opt) =>
    //                 opt.toLowerCase().includes(targetStorefront)
    //               );
    //               if (targetIndex === -1) {
    //                 targetIndex = normalizedOptions.findIndex((opt) => !/create a new storefront/i.test(opt));
    //                 if (targetIndex === -1) targetIndex = 0;
    //               }

    //               const selectedLine = storefrontOptions[targetIndex];
    //               const urlMatch = selectedLine.match(/https?:\/\/[^\s)]+/);
    //               let selectedUrl = urlMatch ? urlMatch[0] : null;

    //               if (selectedUrl) {
    //                 selectedUrl = selectedUrl.replace(/^[()\[\]<>{},]+|[()\[\]<>{},]+$/g, "");
    //                 try {
    //                   if (storeDetails) {
    //                     await prisma.stores.update({
    //                       where: { store_id: storeDetails.store_id },
    //                       data: { storeUrl: selectedUrl, status: "active" },
    //                     });
    //                   }
    //                   urlCaptured = true;
    //                   socket.emit("shopify:storeurl", selectedUrl);
    //                   socket.emit("shopify:status", "Store URL captured on retry");
    //                 } catch (e) {
    //                   console.error("DB update failed (retry)", e);
    //                 }
    //               }

    //               // Move to the option and select to keep CLI state consistent
    //               const cursorLineIndex = storefrontOptions.findIndex((l) => l.includes("❯"));
    //               let currentIndex = cursorLineIndex === -1 ? 0 : cursorLineIndex;
    //               let steps = targetIndex - currentIndex;

    //               navInterval = setInterval(() => {
    //                 if (steps !== 0) {
    //                   relink.write(steps > 0 ? "\x1B[B" : "\x1B[A");
    //                   steps += steps > 0 ? -1 : 1;
    //                 } else {
    //                   relink.write("\r");
    //                   clearInterval(navInterval);
    //                   navInterval = null;
    //                   storefrontBuffer = null;
    //                   selectingStorefront = false;
    //                 }
    //               }, 150);

    //               socket.emit(
    //                 "shopify:status",
    //                 `Selecting Storefront -> ${targetStorefront}`
    //               );
    //             }
    //           }
    //         });

    //         relink.onExit(() => {
    //           if (!urlCaptured) {
    //             socket.emit(
    //               "shopify:failure",
    //               "URL not captured after retry. Please link manually."
    //             );
    //           }
    //         });
    //       } catch (e) {
    //         console.error("Relink attempt failed", e);
    //       }
    //     };

    //     ptyProcess.onData((data) => {
    //       process.stdout.write(data); // Optional: see the CLI output

    //       // Match and capture the verification code
    //       const codeMatch = data.match(
    //         /User verification code:\s*([A-Z0-9-]+)/
    //       );
    //       if (codeMatch) {
    //         console.debug("\nAUTH-CODE");

    //         const code = codeMatch[1];
    //         console.log("User verification code:", code);

    //         socket.emit("shopify:authcode", code);
    //       }
    //       if (
    //         data.includes(
    //           "Press any key to open the login page on your browser"
    //         )
    //       ) {
    //         console.debug("\nOPEN-BROWSER");

    //         // Press "Enter" to select the default option
    //         setTimeout(() => {
    //           ptyProcess.write("\r"); // \r is Enter
    //         }, 500);

    //         socket.emit("shopify:status", "Open Browser");
    //       }
    //       if (data.includes("Opened link to start the auth process")) {
    //         console.debug("\nAUTH-URL");

    //         const authUrl = data.match(
    //           /https:\/\/accounts\.shopify\.com\/activate-with-code\?device_code%5Buser_code%5D=[A-Z0-9\-]+/
    //         );
    //         if (authUrl) {
    //           console.log("Auth URL:", authUrl[0]);
    //           socket.emit("shopify:authurl", authUrl[0]);
    //         }
    //       }
    //       if (data.includes("?  Select a shop to log in to:")) {
    //         console.debug("\nSELECT-SHOP");

    //         // Press "Enter" to select the default option
    //         setTimeout(() => {
    //           ptyProcess.write("\r"); // \r is Enter
    //         }, 500);

    //         socket.emit("shopify:status", "Select Shop");
    //       }
    //       // if (data.includes("?  Select a Hydrogen storefront to link:")) {
    //       //   console.debug("\nSELECT-STORE");

    //       //   // Press "Enter" to select the default option
    //       //   setTimeout(() => {
    //       //     ptyProcess.write("\r"); // \r is Enter
    //       //   }, 500);

    //       //   socket.emit("shopify:status", "Select Store");
    //       // }
    //       if (data.includes("?  Select a Hydrogen storefront to link:")) {
    //         console.debug("\nSELECT-STORE");
          
    //         // Strip ANSI codes so you get clean lines
    //         const noAnsi = data.replace(/\x1b\[[0-9;]*m/g, "");
    //         const lines = noAnsi
    //           .split("\n")
    //           .map((line) => line.trim())
    //           .filter(Boolean);
          
    //         // capture all options (including "Create a new storefront")
    //         const storefrontOptions = lines.filter(
    //           (line) =>
    //             /(https?:\/\/[^\s]+)/.test(line) ||
    //             /Create a new storefront/i.test(line)
    //         );
          
    //         // Normalize: remove markers like ❯ and [default]
    //         const normalizedOptions = storefrontOptions.map((l) =>
    //           l.replace(/^❯?\s*/, "").replace(/\s+\[default\]$/, "").trim()
    //         );
          
    //         // Resolve target storefront name
    //         const targetStorefront = (message.storefrontName || message.name)
    //           .trim()
    //           .toLowerCase();
          
    //         // Find the option index
    //         let targetIndex = normalizedOptions.findIndex((opt) =>
    //           opt.toLowerCase().includes(targetStorefront)
    //         );
    //         if (targetIndex === -1) {
    //           console.warn(
    //             `⚠️ Storefront "${targetStorefront}" not found. Defaulting to first available (not 'Create a new storefront').`
    //           );
    //           targetIndex = normalizedOptions.findIndex(
    //             (opt) => !/create a new storefront/i.test(opt)
    //           );
    //           if (targetIndex === -1) targetIndex = 0;
    //         }
          
    //         const selectedLine = storefrontOptions[targetIndex];
    //         const urlMatch = selectedLine.match(/https?:\/\/[^\s)]+/);
    //         let selectedUrl = urlMatch ? urlMatch[0] : null;
          
    //         if (selectedUrl) {
    //           // Trim leading & trailing punctuation just in case
    //           selectedUrl = selectedUrl.replace(/^[()\[\]<>{},]+|[()\[\]<>{},]+$/g, "");

    //           // Persist URL immediately when available
    //           try {
    //             if (storeDetails) {
    //               (async () => {
    //                 try {
    //                   await prisma.stores.update({
    //                     where: { store_id: storeDetails.store_id },
    //                     data: { storeUrl: selectedUrl, status: "active" },
    //                   });
    //                 } catch (e) {
    //                   console.error("DB update failed", e);
    //                 }
    //               })();
    //             }
    //           } catch {}

    //           urlCaptured = true;
    //           socket.emit("shopify:storeurl", selectedUrl);
    //           console.debug(`✅ Resolved storefront URL: ${selectedUrl}`);
    //         }
          
    //         // Auto-press Enter (default selection)
    //         setTimeout(() => {
    //           ptyProcess.write("\r"); // \r is Enter
    //         }, 500);
          
    //         socket.emit("shopify:status", "Select Store");
    //       }
    //       function stripAnsi(text) {
    //         return text
    //           .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    //           .replace(/\x1b\[[0-9;]*m/g, "");
    //       }

    //       function normalizeInput(str) {
    //         return str
    //           .trim()
    //           .toLowerCase()
    //           .replace(/\s+/g, "")
    //           .replace(/[^a-z0-9\-]/g, "");
    //       }

    //       function isVisualNoise(line) {
    //         const stripped = line.replace(/\s/g, "");
    //         return (
    //           stripped === "" || stripped === ">" || /^[█▔]+$/.test(stripped) // full block or placeholder visuals
    //         );
    //       }

    //       let storefrontNameSubmitted = false;

    //       if (data && data.includes("?  New storefront name:")) {
    //         // Only proceed if we haven't already submitted and it's a relevant prompt
    //         if (!storefrontNameSubmitted && /new storefront name/i.test(data)) {
    //           const cleaned = stripAnsi(data);
    //           const lines = cleaned
    //             .split("\n")
    //             .map((line) => line.trim())
    //             .filter((line) => !isVisualNoise(line));

    //           // Look for the prompt line
    //           const promptLineIndex = lines.findIndex((line) =>
    //             line.startsWith("?  New storefront name:")
    //           );

    //           const candidates = [];

    //           // Check surrounding lines for already-entered name (above, below, same)
    //           if (promptLineIndex >= 0) {
    //             const sameLine = lines[promptLineIndex] || "";
    //             const aboveLine = lines[promptLineIndex - 1] || "";
    //             const belowLine = lines[promptLineIndex + 1] || "";

    //             // Try extracting any names from "✔ <name>" or lines around the prompt
    //             const extractName = (line) => {
    //               const match = line.match(/✔\s+(.*)/);
    //               return match ? match[1] : line;
    //             };

    //             candidates.push(
    //               normalizeInput(extractName(sameLine)),
    //               normalizeInput(extractName(aboveLine)),
    //               normalizeInput(extractName(belowLine))
    //             );
    //           }

    //           const desiredName = normalizeInput(message.name);
    //           const matchFound = candidates.some((c) => c === desiredName);

    //           // Only write the name if not already present
    //           if (!matchFound) {
    //             ptyProcess.write(message.name);
    //             setTimeout(() => ptyProcess.write("\r"), 100); // Enter
    //             storefrontNameSubmitted = true;
    //             socket.emit("shopify:status", "Storefront name handled.");
    //           } else {
    //             storefrontNameSubmitted = true; // Already handled, mark as submitted
    //             socket.emit(
    //               "shopify:status",
    //               "Storefront name already provided."
    //             );
    //           }
    //         }
    //       } 

    //       if (data.includes("Your project is currently linked")) {
    //         // PARTIAL TEXT
    //         console.debug("\nLINK-EXISTS");
    //         // Press "Enter" to select the default option
    //         setTimeout(() => {
    //           ptyProcess.write("\r"); // \r is Enter
    //           //ptyProcess.write("\x1B[B\r"); // ↓ then Enter
    //         }, 500);

    //         socket.emit("shopify:status", "Link Exists");
    //       }
    //       if (data.includes("Could not create storefront")) {
    //         console.debug("STORE-EXISTS");

    //         const noAnsi = data.replace(/\x1b\[[0-9;]*m/g, "");

    //         const messageLines = noAnsi
    //           .split("\n")
    //           .map((line) => line.trim())
    //           .filter(
    //             (line) =>
    //               line &&
    //               !/^[-─╭╰╮╯│]+$/.test(line) &&
    //               !/^╭.*╮$/.test(line) &&
    //               !/^╰.*╯$/.test(line)
    //           )
    //           .map((line) => line.replace(/^│/, "").replace(/│$/, "").trim()); // remove leading/trailing box sides

    //         const finalMessage = messageLines.join(" ");
    //         socket.emit("shopify:failure", finalMessage);
    //       }
    //     });
    //     ptyProcess.onExit(({ exitCode, signal }) => {
    //       //console.log(`\nProcess exited with code ${exitCode}, signal: ${signal}`);
    //       if (exitCode === 0) {
    //         console.log("✅ Hydrogen link successful");
    //         socket.emit("shopify:status", "Link Successful");
    //         // If URL wasn't captured in the first pass (common when creating a new storefront), retry once
    //         if (!urlCaptured) {
    //           socket.emit("shopify:status", "Retrying link to capture URL");
    //           attemptRelinkForUrl();
    //         }

    //         // hydrogenDeployment(themeDir);
    //       } else {
    //         console.log("❌ Hydrogen link failed");
    //         socket.emit(
    //           "shopify:failure",
    //           "Link Failure: " + (signal, exitCode)
    //         );
    //         finalizeProcess(themeDir, true); // Cleanup on error, delete store
    //       }
    //     });
    //   } catch (error) {
    //     console.log("❌ Hydrogen link failed");
    //     socket.emit("shopify:failure", "Link Failure");
    //     finalizeProcess(themeDir, true); // Cleanup on error, delete store
    //   }
    // }
    
    function hydrogenLink(themeDir) {
      let urlCaptured = false;
      let deploymentTriggered = false;
    
      // Helper: trigger deployment once
      function triggerDeployment(themeDir) {
        if (!deploymentTriggered) {
          deploymentTriggered = true;
          setTimeout(() => hydrogenDeployment(themeDir), 1000);
        }
      }
    
      // Helper function to retry link and capture URL
      const attemptRelinkForUrl = () => {
        try {
          const relink = pty.spawn(
            "shopify",
            ["hydrogen", "link", "--path", `${themeDir}`],
            {
              name: "xterm-256color",
              cwd: themeDir,
              env: process.env,
              cols: 80,
              rows: 30,
            }
          );
    
          let relinkBuffer = "";
          let relinkMenuHandled = false;
          let navInterval = null;
    
          relink.onData((data) => {
            process.stdout.write(data);
    
            // Handle auth code
            const codeMatch = data.match(/User verification code:\s*([A-Z0-9-]+)/);
            if (codeMatch) {
              socket.emit("shopify:authcode", codeMatch[1]);
            }
    
            // Handle browser open
            if (data.includes("Press any key to open the login page on your browser")) {
              setTimeout(() => relink.write("\r"), 300);
              socket.emit("shopify:status", "Open Browser");
            }
    
            // Handle auth URL
            if (data.includes("Opened link to start the auth process")) {
              const authUrl = data.match(/https:\/\/accounts\.shopify\.com\/activate-with-code\?device_code%5Buser_code%5D=[A-Z0-9\-]+/);
              if (authUrl) {
                socket.emit("shopify:authurl", authUrl[0]);
              }
            }
    
            // Handle shop selection
            if (data.includes("?  Select a shop to log in to:")) {
              setTimeout(() => relink.write("\r"), 300);
              socket.emit("shopify:status", "Select Shop");
            }
    
            // Handle "already linked" prompt
            if (data.includes("Your project is currently linked")) {
              setTimeout(() => relink.write("\r"), 300);
              socket.emit("shopify:status", "Link Exists");
            }
    
            // Start buffering when storefront selection appears
            if (data.includes("?  Select a Hydrogen storefront to link:")) {
              relinkBuffer = "";
              relinkMenuHandled = false;
            }
    
            if (relinkBuffer !== null) {
              relinkBuffer += data;
    
              if (!relinkMenuHandled && relinkBuffer.includes("Press ↑↓")) {
                relinkMenuHandled = true;
    
                // Parse options
                const noAnsi = relinkBuffer.replace(/\x1b\[[0-9;]*m/g, "");
                const lines = noAnsi.split("\n").map(l => l.trim()).filter(Boolean);
    
                const storefrontOptions = lines.filter(line =>
                  /(https?:\/\/[^\s]+)/.test(line) || /Create a new storefront/i.test(line)
                );
    
                const normalizedOptions = storefrontOptions.map(l =>
                  l.replace(/^❯?\s*/, "").replace(/\s+\[default\]$/, "").trim()
                );
    
                const targetStorefront = (message.storefrontName || message.name).trim().toLowerCase();
                let targetIndex = normalizedOptions.findIndex(opt =>
                  opt.toLowerCase().includes(targetStorefront) && !/create a new storefront/i.test(opt)
                );
    
                if (targetIndex === -1) {
                  targetIndex = normalizedOptions.findIndex(opt => !/create a new storefront/i.test(opt));
                  if (targetIndex === -1) targetIndex = 0;
                }
    
                const selectedLine = storefrontOptions[targetIndex];
                let urlMatch = selectedLine?.match(/https?:\/\/[a-zA-Z0-9-]+\.dev/);
                if (!urlMatch) {
                  // fallback to any https URL if Hydrogen dev storefront isn't found
                  urlMatch = selectedLine?.match(/https?:\/\/[^\s]+/);
                }
                let selectedUrl = urlMatch ? urlMatch[0] : null;
    
                if (selectedUrl) {
                  selectedUrl = selectedUrl.replace(/^[()\[\]<>{},]+|[()\[\]<>{},]+$/g, "");
                  if (storeDetails) {
                    prisma.stores.update({
                      where: { store_id: storeDetails.store_id },
                      data: { storeUrl: selectedUrl, status: "active" },
                    }).catch(e => console.error("DB update failed (retry):", e));
                  }
                  urlCaptured = true;
                  socket.emit("shopify:storeurl", selectedUrl);
                  socket.emit("shopify:status", "Store URL captured on retry");
                  console.log("✅ URL captured on retry:", selectedUrl);
    
                  triggerDeployment(themeDir);
                  return; // Exit early
                }
    
                // If no URL captured, navigate with arrow keys
                if (!urlCaptured) {
                  const cursorLineIndex = storefrontOptions.findIndex(l => l.includes("❯"));
                  let currentIndex = cursorLineIndex === -1 ? 0 : cursorLineIndex;
                  const steps = targetIndex - currentIndex;
    
                  if (steps === 0) {
                    setTimeout(() => relink.write("\r"), 200);
                  } else {
                    let moved = 0;
                    navInterval = setInterval(() => {
                      if (moved < Math.abs(steps)) {
                        relink.write(steps > 0 ? "\x1B[B" : "\x1B[A");
                        moved++;
                      } else {
                        clearInterval(navInterval);
                        navInterval = null;
                        setTimeout(() => relink.write("\r"), 200);
                      }
                    }, 150);
                  }
    
                  socket.emit("shopify:status", `Selecting storefront: ${targetStorefront}`);
                }
              }
            }
          });
    
          relink.onExit(() => {
            if (navInterval) clearInterval(navInterval);
            if (!urlCaptured) {
              socket.emit("shopify:failure", "URL not captured after retry");
            }
          });
        } catch (e) {
          console.error("Relink attempt failed:", e);
        }
      };
    
      try {
        execSync("shopify auth logout", {});
    
        const ptyProcess = pty.spawn(
          "shopify",
          ["hydrogen", "link", "--path", `${themeDir}`],
          {
            name: "xterm-256color",
            cwd: themeDir,
            env: process.env,
            cols: 80,
            rows: 30,
          }
        );
    
        let storefrontBuffer = "";
        let menuHandled = false;
        let nameSubmitted = false;
    
        ptyProcess.onData((data) => {
          process.stdout.write(data);
    
          // Handle auth code
          const codeMatch = data.match(/User verification code:\s*([A-Z0-9-]+)/);
          if (codeMatch) {
            socket.emit("shopify:authcode", codeMatch[1]);
          }
    
          // Handle browser open
          if (data.includes("Press any key to open the login page on your browser")) {
            setTimeout(() => ptyProcess.write("\r"), 500);
            socket.emit("shopify:status", "Open Browser");
          }
    
          // Handle auth URL
          if (data.includes("Opened link to start the auth process")) {
            const authUrl = data.match(
              /https:\/\/accounts\.shopify\.com\/activate-with-code\?device_code%5Buser_code%5D=[A-Z0-9\-]+/
            );
            if (authUrl) {
              socket.emit("shopify:authurl", authUrl[0]);
            }
          }
    
          // Handle shop selection
          if (data.includes("?  Select a shop to log in to:")) {
            setTimeout(() => ptyProcess.write("\r"), 500);
            socket.emit("shopify:status", "Select Shop");
          }
    
          // Handle storefront selection
          if (data.includes("?  Select a Hydrogen storefront to link:")) {
            storefrontBuffer = "";
            menuHandled = false;
          }
    
          if (storefrontBuffer !== null) {
            storefrontBuffer += data;
    
            if (!menuHandled && storefrontBuffer.includes("Press ↑↓")) {
              menuHandled = true;
    
              const lines = storefrontBuffer
                .replace(/\x1b\[[0-9;]*m/g, "")
                .split("\n")
                .map(line => line.trim())
                .filter(Boolean);
    
              const storefrontOptions = lines.filter(line =>
                /https?:\/\/[^\s]+/.test(line) && !line.includes("Create a new storefront")
              );
    
              const targetName = (message.storefrontName || message.name).trim().toLowerCase();
              let targetExists = false;
    
              for (const option of storefrontOptions) {
                if (option.toLowerCase().includes(targetName)) {
                  targetExists = true;
                  const urlMatch = option.match(/https?:\/\/[^\s]+/);
                  if (urlMatch) {
                    const selectedUrl = urlMatch[0];
                    if (storeDetails) {
                      prisma.stores.update({
                        where: { store_id: storeDetails.store_id },
                        data: { storeUrl: selectedUrl, status: "active" },
                      }).catch(e => console.error("DB update failed:", e));
                    }
                    urlCaptured = true;
                    socket.emit("shopify:storeurl", selectedUrl);
                    console.log("✅ URL captured:", selectedUrl);
                  }
                  break;
                }
              }
    
              if (targetExists) {
                socket.emit("shopify:status", "Selecting existing storefront");
                setTimeout(() => ptyProcess.write("\r"), 500);
              } else {
                socket.emit("shopify:status", "Creating new storefront");
                setTimeout(() => ptyProcess.write("\r"), 500);
              }
            }
          }
    
          // Handle new storefront name input
          if (data.includes("?  New storefront name:") && !nameSubmitted) {
            nameSubmitted = true;
            const storeName = (message.name || message.storefrontName || "hydrogen-storefront").trim();
            setTimeout(() => {
              ptyProcess.write(storeName);
              setTimeout(() => ptyProcess.write("\r"), 100);
            }, 100);
            socket.emit("shopify:status", `Creating storefront: ${storeName}`);
          }
    
          // Handle errors
          if (data.includes("Could not create storefront")) {
            const noAnsi = data.replace(/\x1b\[[0-9;]*m/g, "");
            const messageLines = noAnsi
              .split("\n")
              .map(line => line.trim())
              .filter(line => line && !/^[-─╭╰╮╯│]+$/.test(line))
              .map(line => line.replace(/^│/, "").replace(/│$/, "").trim());
            const finalMessage = messageLines.join(" ");
            socket.emit("shopify:failure", finalMessage);
          }
        });
    
        ptyProcess.onExit(({ exitCode, signal }) => {
          if (exitCode === 0) {
            console.log("✅ Hydrogen link successful");
            socket.emit("shopify:status", "Link Successful");
    
            if (!urlCaptured) {
              socket.emit("shopify:status", "Retrying link to capture URL");
              setTimeout(() => attemptRelinkForUrl(), 1000);
            } else {
              triggerDeployment(themeDir);
            }
          } else {
            console.log("❌ Hydrogen link failed");
            socket.emit("shopify:failure", "Link Failure: " + (signal || exitCode));
            finalizeProcess(themeDir, true);
          }
        });
      } catch (error) {
        console.log("❌ Hydrogen link failed");
        socket.emit("shopify:failure", "Link Failure");
        finalizeProcess(themeDir, true);
      }
    }
    
    

    // Deployment hydrogen theme process
    function hydrogenDeployment(themeDir) {
      const ptyProcess2 = pty.spawn(
        "shopify",
        ["hydrogen", "deploy", "--path", `${themeDir}`],
        {
          name: "xterm-color",
          cwd: themeDir,
          env: process.env,
          cols: 80,
          rows: 30,
        }
      );
      ptyProcess2.onData(async (data) => {
        process.stdout.write(data); // Optional: see the CLI output

        // Match and capture the verification code
        if (data.includes("?  Select an environment to deploy to:")) {
          console.debug("\nSELECT-ENVIRONMENT");
          setTimeout(() => {
            // Navigate down to select Production (usually the second option)
            // First, wait a bit for the prompt to fully appear
            setTimeout(() => {
              // Press down arrow to move to Production option
              ptyProcess2.write("\x1B[B"); // Down arrow
              setTimeout(() => {
                // Press Enter to select Production
                ptyProcess2.write("\r");
              }, 100);
            }, 300);
          }, 500);

          socket.emit("shopify:status", "Select Environment");
        }

        if (data.includes("Creating a deployment against Production")) {
          console.debug("\nCONFIRM_ENVIRONMENT");

          setTimeout(() => {
            // Move selection UP to (y) Yes
            ptyProcess2.write("\x1B[A"); // Up arrow

            setTimeout(() => {
              ptyProcess2.write("\r"); // Enter to confirm "Yes"
            }, 100);
          }, 200);

          socket.emit("shopify:status", "Confirm Environment");
        }

        if (data.includes("Successfully deployed to Oxygen")) {
          //PARTIAL TEXT
          console.debug("\nSTORE-URL");

          const previewUrl = data.match(/https?:\/\/[^\s'"']+/i);
          if (previewUrl && storeDetails) {
            console.log("Store URL:", previewUrl[0]);
            socket.emit("shopify:storeurl", previewUrl[0]);
          }
        }
      });
      ptyProcess2.onExit(({ exitCode, signal }) => {
        //console.log(`\nProcess exited with code ${exitCode}, signal: ${signal}`);
        if (exitCode === 0) {
          console.log("✅ Hydrogen deployment successful");
          socket.emit("shopify:status", "Deployment Successful");

          finalizeProcess(themeDir, false); // Success, do not delete store
        } else {
          console.log("❌ Hydrogen deployment failed");
          socket.emit("shopify:failure", "Deployment Failure");
          finalizeProcess(themeDir, true); // Cleanup on error, delete store
        }
      });
    }

    async function finalizeProcess(themeDir, deleteStore = false) {
      try {
        // Do not delete theme directory anymore. Only handle optional DB cleanup.
        if (deleteStore && storeDetails) {
          try {
            await prisma.stores.update({
              where: { store_id: storeDetails.store_id },
              data: { status: "pending" },
            });
            await prisma.$disconnect();
            socket.emit("shopify:status", "Store entry deleted from DB");
          } catch (err) {
            console.error("Failed to delete store from DB", err);
          }
        }
        socket.emit("shopify:success", "Completed!");
      } catch (err) {
        console.error("❌ Finalize process error", err);
      }
    }
  });

  // Update existing Hydrogen storefront: update .env, re-link to specific storefront, and deploy
  socket.on("shopify:update", async (message) => {
    await prisma.$connect();
    // Parse payload
    try {
      message = JSON.parse(message);
    } catch (error) {
      console.error("Payload parsing error occured", error.message);
      socket.emit("shopify:failure", "Invalid Payload");
      return;
    }

    // Basic validation
    if (!message.name) {
      socket.emit("shopify:failure", "Name Missing");
      return;
    }
    const nameRegex = /^[a-zA-Z][a-zA-Z0-9 ]*$/;
    if (!nameRegex.test(message.name)) {
      socket.emit("shopify:failure", "Name Invalid");
      return;
    }
    // Email/phone are optional in update flow; only update if provided

    // Resolve existing theme directory
    const themeDir = path.resolve("./" + message.name);
    if (!fs.existsSync(themeDir)) {
      socket.emit("shopify:failure", "Store folder not found");
      return;
    }

    // Fetch existing store details for potential URL update
    let storeDetails = null;
    try {
      storeDetails = await prisma.stores.findFirst({
        where: { storeName: message.name.trim() },
      });
    } catch (err) {
      console.error("DB lookup failed", err);
    }
    if (message?.googleAdsId && message?.synchronisId) {
      if (!storeDetails) {
        return res.status(404).json({
          success: false,
          message: "Store not found",
        });
      }

      const updatedStore = await prisma.stores.update({
        where: {
          store_id: storeDetails?.store_id,
        },
        data: {
          googleAdsId: message?.googleAdsId || null,
          synchronisId: message?.synchronisId || null,
          updated_at: new Date(),
        },
      });
    }
    // Build env updates
    const hyphenatedStoreName = message.name
      .trim()
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9\-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");

    // Only update keys that are actually provided (no defaults),
    // required fields (name/email/phone) will still be updated.
    // Do NOT update store name keys in update flow
    // - VITE_SHOPIFY_STORE_NAME: stays unchanged
    // - VITE_STORE_NAME: stays unchanged
    const envUpdates = {};

    const setIfPresent = (key, value) => {
      if (value !== undefined && value !== null && value !== "") {
        envUpdates[key] = value;
      }
    };

    // Primary contact and support
    setIfPresent("VITE_SHOPIFY_STORE_EMAIL", message.email?.trim());
    setIfPresent("VITE_STORE_TITLE", message.storeTitle?.trim());
    setIfPresent("VITE_SHOPIFY_STORE_PHONE", message.phone?.trim());
    setIfPresent("VITE_CUSTOMER_SUPPORT_EMAIL", message.email?.trim());
    setIfPresent("VITE_CUSTOMER_SERVICE_PHONE", message.phone?.trim());
    setIfPresent("VITE_DOMAIN_NAME", message.domainName);
    setIfPresent("VITE_SHOPIFY_URL", message.shopifyUrl);
    setIfPresent("VITE_SHOPIFY_EMAIL", message.shopifyEmail);
    setIfPresent("VITE_SHOPIFY_ADMIN_ACCESS_TOKEN", message.shopifyAdminToken);
    setIfPresent("VITE_COMPANY_NAME", message.companyName);
    setIfPresent("VITE_COMPANY_ADDRESS", message.companyAddress);
    setIfPresent("VITE_SIREN_NUMBER", message.companyBusinessNumber || "");
    setIfPresent("VITE_PP_LAST_UPDATED_DATE", message.policyUpdatedAt || "");
    setIfPresent("VITE_BUSINESS_HOURS", message.businessHours || "");
    setIfPresent("VITE_REFUND_PERIOD", message.refundPeriod || "");
    setIfPresent(
      "VITE_REFUND_PROCESSING_TIME",
      message.refundProcessingTime || ""
    );
    setIfPresent("VITE_DELIVERY_PROVIDER", message.deliveryProvider);
    setIfPresent("VITE_DELIVERY_AREAS", message.deliveryAreas);
    setIfPresent("VITE_ORDER_PROCESSING_TIME", message.orderProcessingTime);
    setIfPresent("VITE_STANDARD_DELIVERY_TIME", message.standardDeliveryTime);
    setIfPresent("VITE_RETURN_PERIOD", message.returnPeriod);
    setIfPresent("VITE_SUPPORT_HOURS", message.supportHours);
    setIfPresent("VITE_WITHDRAWAL_PERIOD", message.withdrawalPeriod);
    setIfPresent("VITE_RETURN_SHIPPING_POLICY", message.returnShippingPolicy);
    setIfPresent("VITE_SALE_ITEMS_POLICY", message.saleItemsPolicy);
    setIfPresent("VITE_TC_LAST_UPDATED_DATE", message.termsOfServiceUpdateAt);
    setIfPresent("VITE_GOOGLE_ADS_ID", message.googleAdsId);
    setIfPresent("VITE_SYNCHRONIS_ID", message.synchronisId);

    function upsertEnvFile(envPath, updates) {
      let existing = {};
      try {
        if (fs.existsSync(envPath)) {
          const content = fs.readFileSync(envPath, "utf8");
          content.split(/\r?\n/).forEach((line) => {
            if (!line || line.trim().startsWith("#")) return;
            const eqIndex = line.indexOf("=");
            if (eqIndex === -1) return;
            const key = line
              .slice(0, eqIndex)
              .trim()
              .replace(/^export\s+/, "");
            const value = line
              .slice(eqIndex + 1)
              .trim()
              .replace(/^"|"$/g, "");
            if (key) existing[key] = value;
          });
        }
      } catch (e) {
        console.error("Failed reading existing .env", e);
      }

      for (const [k, v] of Object.entries(updates)) {
        if (v !== undefined) {
          existing[k] = typeof v === "string" ? v : String(v);
        }
      }

      const header = ["# Custom theme configuration (updated)"];
      const bodyLines = Object.entries(existing).map(([k, v]) => `${k}="${v}"`);
      const output = header.concat(bodyLines).join(os.EOL) + os.EOL;
      try {
        fs.writeFileSync(envPath, output, "utf8");
        return true;
      } catch (e) {
        console.error("Failed writing .env", e);
        return false;
      }
    }

    // Update .env
    const envPath = path.join(themeDir, ".env");
    const envResult = upsertEnvFile(envPath, envUpdates);
    if (!envResult) {
      socket.emit("shopify:failure", ".env update failed");
      return;
    }
    socket.emit("shopify:status", "Environment updated");

    function hydrogenLinkUpdate(themeDir) {
      try {
        execSync("shopify auth logout", {});

        const ptyProcess = pty.spawn(
          "shopify",
          ["hydrogen", "link", "--path", `${themeDir}`],
          {
            name: "xterm-256color",
            cwd: themeDir,
            env: process.env,
            cols: 80,
            rows: 30,
          }
        );

        let storefrontBuffer = null;
        let selectingStorefront = false;
        let navInterval = null;

        ptyProcess.onData(async (data) => {
          process.stdout.write(data);

          // --- 🔐 LOGIN HANDLING ---
          const codeMatch = data.match(
            /User verification code:\s*([A-Z0-9-]+)/
          );
          if (codeMatch) {
            const code = codeMatch[1];
            socket.emit("shopify:authcode", code);
          }

          if (
            data.includes(
              "Press any key to open the login page on your browser"
            )
          ) {
            setTimeout(() => {
              ptyProcess.write("\r");
            }, 300);
            socket.emit("shopify:status", "Open Browser");
          }

          if (data.includes("Opened link to start the auth process")) {
            console.debug("\nAUTH-URL");

            const authUrl = data.match(
              /https:\/\/accounts\.shopify\.com\/activate-with-code\?device_code%5Buser_code%5D=[A-Z0-9\-]+/
            );
            if (authUrl) {
              console.log("Auth URL:", authUrl[0]);
              socket.emit("shopify:authurl", authUrl[0]);
            }
          }

          if (data.includes("?  Select a shop to log in to:")) {
            setTimeout(() => {
              ptyProcess.write("\r"); // auto-select first shop
            }, 300);
            socket.emit("shopify:status", "Select Shop");
          }

          // --- 🌐 HYDROGEN LINK FLOW ---

          // Step 1: Confirm prompt
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

              const noAnsi = storefrontBuffer.replace(/\x1b\[[0-9;]*m/g, "");
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
                  .replace(/^❯?\s*/, "")
                  .replace(/\s+\[default\]$/, "")
                  .trim()
              );

              const targetStorefront = (message.storefrontName || message.name)
                .trim()
                .toLowerCase();

              // find target index (match name or URL fragment, case-insensitive)
              let targetIndex = normalizedOptions.findIndex((opt) =>
                opt.toLowerCase().includes(targetStorefront)
              );

              const selectedLine = storefrontOptions[targetIndex];

              const urlMatch = selectedLine.match(/https?:\/\/[^\s]+/);
              let selectedUrl = urlMatch ? urlMatch[0] : null;

              if (selectedUrl) {
                selectedUrl = selectedUrl.replace(/^[()\[\]<>{},]+|[()\[\]<>{},]+$/g, "");
                try {
                  await prisma.stores.update({
                    where: { store_id: storeDetails.store_id },
                    data: { storeUrl: selectedUrl, status: "active" },
                  });
                  socket.emit("shopify:storeurl", previewUrl[0]);
                } catch (e) {
                  console.error("DB update failed", e);
                }
                console.debug(`✅ Resolved storefront URL: ${selectedUrl}`);
              }

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
                socket.emit(
                  "shopify:failure",
                  "Resolved to 'Create a new storefront' — aborting"
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
                socket.emit(
                  "shopify:status",
                  `Already on target storefront -> ${targetStorefront}`
                );
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

              socket.emit(
                "shopify:status",
                `Selecting Storefront -> ${targetStorefront}`
              );
            }
          }

          // Step 4: Storefront echo
          if (
            data.includes("✔") &&
            data.includes("Select a Hydrogen storefront")
          ) {
            console.debug("STORE-LINK CONFIRMED");
            socket.emit("shopify:status", "Storefront linked successfully");
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
            socket.emit("shopify:status", "Link Exists");
          }

          if (data.includes("Could not create storefront")) {
            const noAnsi = data.replace(/\x1b\[[0-9;]*m/g, "");
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
              .map((line) => line.replace(/^│/, "").replace(/│$/, "").trim());
            const finalMessage = messageLines.join(" ");
            socket.emit("shopify:failure", finalMessage);
          }
        });

        ptyProcess.onExit(({ exitCode }) => {
          if (exitCode === 0) {
            socket.emit("shopify:status", "Link Successful");
            hydrogenDeploymentUpdate(themeDir);
          } else {
            socket.emit("shopify:failure", "Link Failure");
            finalizeUpdate();
          }
        });
      } catch (error) {
        console.log("❌ Hydrogen link failed");
        socket.emit("shopify:failure", "Link Failure");
        finalizeUpdate();
      }
    }

    function hydrogenDeploymentUpdate(themeDir) {
      console.log(themeDir, "CWD");
      console.debug(themeDir, "CWD Debug");
      const ptyProcess2 = pty.spawn(
        "shopify",
        ["hydrogen", "deploy", "--path", `${themeDir}`, "--force"],
        {
          name: "xterm-color",
          cwd: themeDir,
          env: process.env,
          cols: 80,
          rows: 30,
        }
      );
      ptyProcess2.onData(async (data) => {
        process.stdout.write(data);

        if (data.includes("?  Select an environment to deploy to:")) {
          setTimeout(() => {
            setTimeout(() => {
              ptyProcess2.write("\x1B[B");
              setTimeout(() => {
                ptyProcess2.write("\r");
              }, 100);
            }, 300);
          }, 500);
          socket.emit("shopify:status", "Select Environment");
        }

        if (data.includes("Creating a deployment against Production")) {
          setTimeout(() => {
            ptyProcess2.write("\x1B[A");
            setTimeout(() => {
              ptyProcess2.write("\r");
            }, 100);
          }, 200);
          socket.emit("shopify:status", "Confirm Environment");
        }

        if (data.includes("Successfully deployed to Oxygen")) {
          const previewUrl = data.match(/https?:\/\/[^\s'"']+/i);
          if (previewUrl && storeDetails) {
            try {
              socket.emit("shopify:storeurl", previewUrl[0]);
            } catch (e) {
              console.error("DB update failed", e);
            }
          }
        }
      });
      ptyProcess2.onExit(({ exitCode }) => {
        if (exitCode === 0) {
          socket.emit("shopify:status", "Deployment Successful");
          finalizeUpdate();
        } else {
          socket.emit("shopify:failure", "Deployment Failure");
          finalizeUpdate();
        }
      });
    }

    function finalizeUpdate() {
      socket.emit("shopify:success", "Update Completed!");
    }

    hydrogenLinkUpdate(themeDir);
  });
};
