const os = require("os");
const path = require("path");
const fs = require("node:fs");
const { PrismaClient } = require("./generated/prisma");
const prisma = new PrismaClient();

const { execSync } = require("child_process");
const pty = require("node-pty");
const sharp = require("sharp");
const { parse } = require("csv-parse/sync");

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
      ? message.name
          .trim()
          .replace(/\s+/g, "-")
          .replace(/[^a-zA-Z0-9\-]/g, "-")
          .replace(/-+/g, "-")
          .replace(/^-+|-+$/g, "")
      : "";
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
VITE_COMPANY_CITY="${message.companyCity || ""}"

# Checkout Configuration
VITE_CHECKOUT_DOMAIN="${message.checkoutDomain || ""}"
VITE_CHECKOUT_ID="${message.checkoutId || ""}"
VITE_OFFER_ID_TYPE="${message.offerIdType || "default"}"

VITE_DISCOVER_OUR_COLLECTIONS=${message?.discoverOurCollections || []}
VITE_CUSTOM_OFFER_IDS=${JSON.stringify(message.customOffers) || {}}
`;

    // Append dynamic Custom Offer IDs to the env
    try {
      const customOfferIds = message.customOfferIds || {};
      if (customOfferIds && typeof customOfferIds === "object") {
        const normalizeKey = (k) =>
          k
            ? String(k)
                .trim()
                .replace(/\s+/g, "")
                .replace(/\./g, "_")
                .replace(/[^0-9_]/g, "")
            : "";
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
            const codeMatch = data.match(
              /User verification code:\s*([A-Z0-9-]+)/
            );
            if (codeMatch) {
              socket.emit("shopify:authcode", codeMatch[1]);
            }

            // Handle browser open
            if (
              data.includes(
                "Press any key to open the login page on your browser"
              )
            ) {
              setTimeout(() => relink.write("\r"), 300);
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
                const noAnsi = relinkBuffer
                  ? relinkBuffer.replace(/\x1b\[[0-9;]*m/g, "")
                  : "";
                const lines = noAnsi
                  .split("\n")
                  .map((l) => l.trim())
                  .filter(Boolean);

                const storefrontOptions = lines.filter(
                  (line) =>
                    /(https?:\/\/[^\s]+)/.test(line) ||
                    /Create a new storefront/i.test(line)
                );

                const normalizedOptions = storefrontOptions.map((l) =>
                  l
                    ? l
                        .replace(/^❯?\s*/, "")
                        .replace(/\s+\[default\]$/, "")
                        .trim()
                    : ""
                );

                const targetStorefront = (
                  message.storefrontName || message.name
                )
                  .trim()
                  .toLowerCase();
                let targetIndex = normalizedOptions.findIndex(
                  (opt) =>
                    opt.toLowerCase().includes(targetStorefront) &&
                    !/create a new storefront/i.test(opt)
                );

                if (targetIndex === -1) {
                  targetIndex = normalizedOptions.findIndex(
                    (opt) => !/create a new storefront/i.test(opt)
                  );
                  if (targetIndex === -1) targetIndex = 0;
                }

                const selectedLine = storefrontOptions[targetIndex];
                let urlMatch = selectedLine?.match(
                  /https?:\/\/[a-zA-Z0-9-]+\.dev/
                );
                if (!urlMatch) {
                  // fallback to any https URL if Hydrogen dev storefront isn't found
                  urlMatch = selectedLine?.match(/https?:\/\/[^\s]+/);
                }
                let selectedUrl = urlMatch ? urlMatch[0] : null;

                if (selectedUrl) {
                  selectedUrl = selectedUrl
                    ? selectedUrl.replace(
                        /^[()\[\]<>{},]+|[()\[\]<>{},]+$/g,
                        ""
                      )
                    : "";
                  if (storeDetails) {
                    const withoutProtocol = message?.shopifyUrl
                      ? message.shopifyUrl.replace(/^https?:\/\//, "")
                      : "";
                    const storeName =
                      withoutProtocol.split(".myshopify.com")[0];

                    prisma.stores
                      .update({
                        where: { store_id: storeDetails.store_id },
                        data: {
                          storeUrl: selectedUrl,
                          status: "active",
                          shopifyUrl: `https://admin.shopify.com/store/${storeName}/hydrogen`,
                        },
                      })
                      .catch((e) =>
                        console.error("DB update failed (retry):", e)
                      );
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
                  const cursorLineIndex = storefrontOptions.findIndex((l) =>
                    l.includes("❯")
                  );
                  let currentIndex =
                    cursorLineIndex === -1 ? 0 : cursorLineIndex;
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

                  socket.emit(
                    "shopify:status",
                    `Selecting storefront: ${targetStorefront}`
                  );
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
        const ptyProcessLogin = pty.spawn(
          "shopify",
          ["hydrogen", "login", "--path", `${themeDir}`],
          {
            name: "xterm-256color",
            cwd: themeDir,
            env: process.env,
            cols: 80,
            rows: 30,
          }
        );

        ptyProcessLogin.onData((data) => {
          process.stdout.write(data);

          // Handle auth code
          const codeMatch = data.match(
            /User verification code:\s*([A-Z0-9-]+)/
          );
          if (codeMatch) {
            console.log("shopify:authcode", codeMatch[1]);
          }

          // Handle browser open
          if (
            data.includes(
              "Press any key to open the login page on your browser"
            )
          ) {
            setTimeout(() => ptyProcessLogin.write("\r"), 500);
            console.log("shopify:status", "Open Browser");
          }

          // Handle auth URL
          if (data.includes("Opened link to start the auth process")) {
            const authUrl = data.match(
              /https:\/\/accounts\.shopify\.com\/activate-with-code\?device_code%5Buser_code%5D=[A-Z0-9\-]+/
            );
            if (authUrl) {
              console.log("shopify:authurl", authUrl[0]);
              socket.emit("shopify:authurl", authUrl[0]);
            }
          }

          // Handle shop selection
          if (data.includes("?  Select a shop to log in to:")) {
            setTimeout(() => ptyProcessLogin.write("\r"), 500);
            console.log("shopify:status", "Select Shop");
          }
        });

        ptyProcessLogin.onExit(({ exitCode, signal }) => {
          if (exitCode === 0) {
            console.log("✅ Hydrogen Login successful");
            hydrogenReLink();
            console.log("shopify:status", "Login Successful");
          } else {
            console.log("❌ Hydrogen login failed");
            console.error(
              "shopify:failure",
              "Login Failure: " + (signal || exitCode)
            );
            //   finalizeProcess(themeDir, true);
          }
        });
        function hydrogenReLink() {
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
            // const codeMatch = data.match(
            //   /User verification code:\s*([A-Z0-9-]+)/
            // );
            //   socket.emit("shopify:authcode", codeMatch[1]);
            // }

            // // Handle browser open
            // if (
            //   data.includes(
            //     "Press any key to open the login page on your browser"
            //   )
            // ) {
            //   setTimeout(() => ptyProcess.write("\r"), 500);
            //   socket.emit("shopify:status", "Open Browser");
            // }

            // // Handle auth URL
            // if (data.includes("Opened link to start the auth process")) {
            //   const authUrl = data.match(
            //     /https:\/\/accounts\.shopify\.com\/activate-with-code\?device_code%5Buser_code%5D=[A-Z0-9\-]+/
            //   );
            //   if (authUrl) {
            //     socket.emit("shopify:authurl", authUrl[0]);
            //   }
            // }

            // Handle shop selection
            // if (data.includes("?  Select a shop to log in to:")) {
            //   setTimeout(() => ptyProcess.write("\r"), 500);
            //   socket.emit("shopify:status", "Select Shop");
            // }

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
                  ? storefrontBuffer
                      .replace(/\x1b\[[0-9;]*m/g, "")
                      .split("\n")
                      .map((line) => line.trim())
                      .filter(Boolean)
                  : [];

                const storefrontOptions = lines.filter(
                  (line) =>
                    /https?:\/\/[^\s]+/.test(line) &&
                    !line.includes("Create a new storefront")
                );

                const targetName = (message.storefrontName || message.name)
                  .trim()
                  .toLowerCase();
                let targetExists = false;

                for (const option of storefrontOptions) {
                  if (option.toLowerCase().includes(targetName)) {
                    targetExists = true;
                    const urlMatch = option.match(/https?:\/\/[^\s]+/);
                    if (urlMatch) {
                      const selectedUrl = urlMatch[0];
                      if (storeDetails) {
                        prisma.stores
                          .update({
                            where: { store_id: storeDetails.store_id },
                            data: { storeUrl: selectedUrl, status: "active" },
                          })
                          .catch((e) => console.error("DB update failed:", e));
                      }
                      urlCaptured = true;
                      socket.emit("shopify:storeurl", selectedUrl);
                      console.log("✅ URL captured:", selectedUrl);
                    }
                    break;
                  }
                }

                if (targetExists) {
                  socket.emit(
                    "shopify:status",
                    "Selecting existing storefront"
                  );
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
              const storeName = (
                message.name ||
                message.storefrontName ||
                "hydrogen-storefront"
              ).trim();
              setTimeout(() => {
                ptyProcess.write(storeName);
                setTimeout(() => ptyProcess.write("\r"), 100);
              }, 100);
              socket.emit(
                "shopify:status",
                `Creating storefront: ${storeName}`
              );
            }

            // Handle errors
            if (data.includes("Could not create storefront")) {
              const noAnsi = data ? data.replace(/\x1b\[[0-9;]*m/g, "") : "";
              const messageLines = noAnsi
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => line && !/^[-─╭╰╮╯│]+$/.test(line))
                .map((line) =>
                  line ? line.replace(/^│/, "").replace(/│$/, "").trim() : ""
                );
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
              socket.emit(
                "shopify:failure",
                "Link Failure: " + (signal || exitCode)
              );
              finalizeProcess(themeDir, true);
            }
          });
        }
      } catch (error) {
        console.log("❌ Hydrogen link failed");
        socket.emit("shopify:failure", "Link Failure");
        finalizeProcess(themeDir, true);
      }
    }

    // function hydrogenLink(themeDir) {
    //   let urlCaptured = false;
    //   let deploymentTriggered = false;

    //   // --- Helpers ---
    //   function triggerDeploymentOnce(themeDir) {
    //     if (!deploymentTriggered) {
    //       deploymentTriggered = true;
    //       setTimeout(() => hydrogenDeployment(themeDir), 1000);
    //     }
    //   }

    //   function attemptHydrogenLink(themeDir, isRetry = false) {
    //     const ptyProcess = pty.spawn(
    //       "shopify",
    //       ["hydrogen", "link", "--path", themeDir],
    //       {
    //         name: "xterm-256color",
    //         cwd: themeDir,
    //         env: process.env,
    //         cols: 80,
    //         rows: 30,
    //       }
    //     );

    //     let storefrontBuffer = "";
    //     let menuHandled = false;
    //     let nameSubmitted = false;
    //     let navInterval = null;

    //     ptyProcess.onData((data) => {
    //       process.stdout.write(data);

    //       // Auth code
    //       // const codeMatch = data.match(/User verification code:\s*([A-Z0-9-]+)/);
    //       // if (codeMatch) socket.emit("shopify:authcode", codeMatch[1]);

    //       // // Browser open
    //       // if (data.includes("Press any key to open the login page on your browser")) {
    //       //   setTimeout(() => ptyProcess.write("\r"), 300);
    //       //   socket.emit("shopify:status", "Open Browser");
    //       // }

    //       // // Auth URL
    //       // if (data.includes("Opened link to start the auth process")) {
    //       //   const authUrl = data.match(/https:\/\/accounts\.shopify\.com\/activate-with-code\?device_code%5Buser_code%5D=[A-Z0-9\-]+/);
    //       //   if (authUrl) socket.emit("shopify:authurl", authUrl[0]);
    //       // }

    //       // // Shop selection
    //       // if (data.includes("?  Select a shop to log in to:")) {
    //       //   setTimeout(() => ptyProcess.write("\r"), 300);
    //       //   socket.emit("shopify:status", "Select Shop");
    //       // }

    //       // Already linked
    //       if (data.includes("Your project is currently linked")) {
    //         setTimeout(() => ptyProcess.write("\r"), 300);
    //         socket.emit("shopify:status", "Link Exists");
    //       }

    //       // Start buffering storefront selection
    //       if (
    //         data.includes(
    //           "?  Select a Hydrogen storefront to link:" ||
    //             data.includes(
    //               "You haven't linked your project to a storefront yet"
    //             )
    //         )
    //       ) {
    //         storefrontBuffer = "";
    //         menuHandled = false;
    //       }

    //       // Parse storefront list
    //       // Parse storefront list
    //       if (storefrontBuffer !== null) {
    //         storefrontBuffer += data;

    //         if (!menuHandled && storefrontBuffer.includes("Press ↑↓")) {
    //           menuHandled = true;

    //           const noAnsi = storefrontBuffer.replace(/\x1b\[[0-9;]*m/g, "");
    //           const lines = noAnsi
    //             .split("\n")
    //             .map((l) => l.trim())
    //             .filter(Boolean);

    //           const storefrontOptions = lines.filter(
    //             (line) =>
    //               /(https?:\/\/[^\s]+)/.test(line) ||
    //               /Create a new storefront/i.test(line)
    //           );

    //           // ✅ First-time link: only "Create a new storefront"
    //           if (
    //             storefrontOptions.length === 1 &&
    //             /Create a new storefront/i.test(storefrontOptions[0])
    //           ) {
    //             socket.emit(
    //               "shopify:status",
    //               "No existing storefronts, creating new one"
    //             );

    //             setTimeout(() => ptyProcess.write("\r"), 300); // select "Create a new storefront"
    //             return; // let CLI prompt for name next
    //           }

    //           // --- Existing storefront flow ---
    //           const normalizedOptions = storefrontOptions.map((l) =>
    //             l
    //               .replace(/^❯?\s*/, "")
    //               .replace(/\s+\[default\]$/, "")
    //               .trim()
    //           );

    //           const targetStorefront = (message.storefrontName || message.name)
    //             .trim()
    //             .toLowerCase();
    //           let targetIndex = normalizedOptions.findIndex(
    //             (opt) =>
    //               opt.toLowerCase().includes(targetStorefront) &&
    //               !/create a new storefront/i.test(opt)
    //           );

    //           if (targetIndex === -1) {
    //             targetIndex = normalizedOptions.findIndex(
    //               (opt) => !/create a new storefront/i.test(opt)
    //             );
    //             if (targetIndex === -1) targetIndex = 0;
    //           }

    //           const selectedLine = storefrontOptions[targetIndex];
    //           let urlMatch = selectedLine?.match(
    //             /https?:\/\/[a-zA-Z0-9-]+\.dev/
    //           );
    //           if (!urlMatch)
    //             urlMatch = selectedLine?.match(/https?:\/\/[^\s]+/);

    //           let selectedUrl = urlMatch ? urlMatch[0] : null;

    //           if (selectedUrl) {
    //             selectedUrl = selectedUrl.replace(
    //               /^[()\[\]<>{},]+|[()\[\]<>{},]+$/g,
    //               ""
    //             );
    //             urlCaptured = true;
    //             socket.emit("shopify:storeurl", selectedUrl);
    //             console.log(
    //               isRetry ? "✅ URL captured on retry:" : "✅ URL captured:",
    //               selectedUrl
    //             );
    //             triggerDeploymentOnce(themeDir);
    //             return;
    //           }

    //           // If no URL captured → simulate navigation
    //           if (!urlCaptured) {
    //             const cursorLineIndex = storefrontOptions.findIndex((l) =>
    //               l.includes("❯")
    //             );
    //             let currentIndex = cursorLineIndex === -1 ? 0 : cursorLineIndex;
    //             const steps = targetIndex - currentIndex;

    //             if (steps === 0) {
    //               setTimeout(() => ptyProcess.write("\r"), 200);
    //             } else {
    //               let moved = 0;
    //               navInterval = setInterval(() => {
    //                 if (moved < Math.abs(steps)) {
    //                   ptyProcess.write(steps > 0 ? "\x1B[B" : "\x1B[A");
    //                   moved++;
    //                 } else {
    //                   clearInterval(navInterval);
    //                   navInterval = null;
    //                   setTimeout(() => ptyProcess.write("\r"), 200);
    //                 }
    //               }, 150);
    //             }
    //             socket.emit(
    //               "shopify:status",
    //               `Selecting storefront: ${targetStorefront}`
    //             );
    //           }
    //         }
    //       }

    //       // New storefront creation
    //       if (data.includes("?  New storefront name:") && !nameSubmitted) {
    //         nameSubmitted = true;
    //         const storeName = (
    //           message.name ||
    //           message.storefrontName ||
    //           "hydrogen-storefront"
    //         ).trim();
    //         setTimeout(() => {
    //           ptyProcess.write(storeName);
    //           setTimeout(() => ptyProcess.write("\r"), 100);
    //         }, 100);
    //         socket.emit("shopify:status", `Creating storefront: ${storeName}`);
    //       }

    //       // New storefront creation
    //       if (data.includes("?  New storefront name:") && !nameSubmitted) {
    //         nameSubmitted = true;
    //         const storeName = (
    //           message.name ||
    //           message.storefrontName ||
    //           "hydrogen-storefront"
    //         ).trim();
    //         setTimeout(() => {
    //           ptyProcess.write(storeName);
    //           setTimeout(() => ptyProcess.write("\r"), 100);
    //         }, 100);
    //         socket.emit("shopify:status", `Creating storefront: ${storeName}`);
    //       }

    //       // Error handling
    //       if (data.includes("Could not create storefront")) {
    //         const noAnsi = data.replace(/\x1b\[[0-9;]*m/g, "");
    //         const messageLines = noAnsi
    //           .split("\n")
    //           .map((line) => line.trim())
    //           .filter((line) => line && !/^[-─╭╰╮╯│]+$/.test(line));
    //         const finalMessage = messageLines.join(" ");
    //         socket.emit("shopify:failure", finalMessage);
    //       }
    //     });

    //     ptyProcess.onExit(({ exitCode }) => {
    //       if (navInterval) clearInterval(navInterval);
    //       if (exitCode === 0) {
    //         console.log("✅ Hydrogen link successful");
    //         socket.emit("shopify:status", "Link Successful");

    //         if (!urlCaptured && !isRetry) {
    //           socket.emit("shopify:status", "Retrying link to capture URL");
    //           setTimeout(() => attemptHydrogenLink(themeDir, true), 1000);
    //         } else if (urlCaptured) {
    //           triggerDeploymentOnce(themeDir);
    //         }
    //       } else {
    //         console.log("❌ Hydrogen link failed");
    //         socket.emit("shopify:failure", "Link Failure: " + exitCode);
    //         finalizeProcess(themeDir, true);
    //       }
    //     });
    //   }

    //   // --- MAIN FLOW ---
    //   try {
    //     execSync("shopify auth logout", {});
    //     const ptyProcessLogin = pty.spawn(
    //       "shopify",
    //       ["hydrogen", "login", "--path", `${themeDir}`],
    //       {
    //         name: "xterm-256color",
    //         cwd: themeDir,
    //         env: process.env,
    //         cols: 80,
    //         rows: 30,
    //       }
    //     );

    //     ptyProcessLogin.onData((data) => {
    //       process.stdout.write(data);
    //       if (/User verification code:\s*([A-Z0-9-]+)/.test(data))
    //         console.log("shopify:authcode", RegExp.$1);
    //       if (
    //         data.includes(
    //           "Press any key to open the login page on your browser"
    //         )
    //       ) {
    //         setTimeout(() => ptyProcessLogin.write("\r"), 500);
    //         console.log("shopify:status", "Open Browser");
    //       }
    //       if (data.includes("Opened link to start the auth process")) {
    //         const authUrl = data.match(
    //           /https:\/\/accounts\.shopify\.com\/activate-with-code\?device_code%5Buser_code%5D=[A-Z0-9\-]+/
    //         );
    //         if (authUrl) {
    //           console.log("shopify:authurl", authUrl[0]);
    //           socket.emit("shopify:authurl", authUrl[0]);
    //         }
    //       }
    //       if (data.includes("?  Select a shop to log in to:")) {
    //         setTimeout(() => ptyProcessLogin.write("\r"), 500);
    //         console.log("shopify:status", "Select Shop");
    //       }
    //     });

    //     ptyProcessLogin.onExit(({ exitCode }) => {
    //       if (exitCode === 0) {
    //         console.log("✅ Hydrogen Login successful");
    //         console.log("shopify:status", "Login Successful");
    //         attemptHydrogenLink(themeDir, false); // only start linking after login success
    //       } else {
    //         console.log("❌ Hydrogen login failed");
    //         socket.emit("shopify:failure", "Login Failure: " + exitCode);
    //       }
    //     });
    //   } catch (error) {
    //     console.log("❌ Hydrogen link failed (exception)");
    //     socket.emit("shopify:failure", "Link Failure");
    //     finalizeProcess(themeDir, true);
    //   }
    // }

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
      ? message.name
          .trim()
          .replace(/\s+/g, "-")
          .replace(/[^a-zA-Z0-9\-]/g, "-")
          .replace(/-+/g, "-")
          .replace(/^-+|-+$/g, "")
      : "";

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
    setIfPresent("VITE_COMPANY_CITY", message.companyCity);
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
                selectedUrl = selectedUrl
                  ? selectedUrl.replace(/^[()\[\]<>{},]+|[()\[\]<>{},]+$/g, "")
                  : "";
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

  // Publish collections/products from local theme data
  socket.on("publish:collections", async (payload) => {
    try {
      // Validate input
      // const payload = JSON.parse(message);
      if (
        !payload ||
        !payload.storeName ||
        typeof payload.storeName !== "string"
      ) {
        socket.emit("publish:error", {
          stage: "init",
          message: "Invalid or missing storeName",
        });
        return;
      }

      const storeName = payload.storeName.trim();
      const storeDir = path.resolve("./" + storeName);

      // 1) Validate store folder exists
      if (!fs.existsSync(storeDir)) {
        socket.emit("publish:not_found", {
          stage: "store",
          message: "Store folder not found",
          storeDir,
        });
        return;
      }

      // 2) Read .env for CATEGORY and LANGUAGE
      const envPath = path.join(storeDir, ".env");
      if (!fs.existsSync(envPath)) {
        socket.emit("publish:not_found", {
          stage: "env",
          message: ".env file not found in store folder",
          envPath,
        });
        return;
      }

      const envContent = fs.readFileSync(envPath, "utf8");
      const envLines = envContent.split(/\r?\n/);
      const envMap = {};
      for (const line of envLines) {
        if (!line || line.trim().startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq === -1) continue;
        const key = line
          .slice(0, eq)
          .trim()
          .replace(/^export\s+/, "");
        const value = line
          .slice(eq + 1)
          .trim()
          .replace(/^"|"$/g, "");
        if (key) envMap[key] = value;
      }

      const category = envMap["VITE_CATEGORY"];
      const language = envMap["VITE_LANGUAGE"];

      if (!category || !language) {
        socket.emit("publish:error", {
          stage: "env",
          message: "VITE_CATEGORY or VITE_LANGUAGE missing in .env",
        });
        return;
      }

      socket.emit("publish:category_language", { category, language });

      // 3) Resolve theme data folder (e.g., deco_en)
      const themeFolderName = `${category}_${language}`;
      const themeFolderPath = path.resolve(`./${themeFolderName}`);
      if (
        !fs.existsSync(themeFolderPath) ||
        !fs.lstatSync(themeFolderPath).isDirectory()
      ) {
        socket.emit("publish:not_found", {
          stage: "theme_folder",
          message: "Theme folder not found",
          themeFolderPath,
        });
        return;
      }

      // 4) Find collections CSV file
      const preferredCsvName = `${themeFolderName}.csv`;
      let collectionsCsvPath = path.join(themeFolderPath, preferredCsvName);

      if (!fs.existsSync(collectionsCsvPath)) {
        // Fallback: search for any CSV matching the theme prefix, else any .csv
        const files = fs.readdirSync(themeFolderPath);
        const candidates = files.filter((f) =>
          f.toLowerCase().endsWith(".csv")
        );
        const prefixed = candidates.find((f) =>
          f.toLowerCase().startsWith(themeFolderName.toLowerCase())
        );
        collectionsCsvPath = prefixed
          ? path.join(themeFolderPath, prefixed)
          : null;
      }

      if (!collectionsCsvPath || !fs.existsSync(collectionsCsvPath)) {
        socket.emit("publish:not_found", {
          stage: "collections_csv",
          message: "Collections CSV not found",
          themeFolderPath,
        });
        return;
      }

      // 5) Read file contents
      let csvContent = null;
      try {
        csvContent = fs.readFileSync(collectionsCsvPath, "utf8");
      } catch (e) {
        socket.emit("publish:error", {
          stage: "collections_read",
          message: e.message,
        });
        return;
      }

      // 6) Parse CSV with proper quoted field handling
      function parseCSVLine(line) {
        const result = [];
        let current = "";
        let inQuotes = false;
        let i = 0;

        while (i < line.length) {
          const char = line[i];

          if (char === '"') {
            if (inQuotes && line[i + 1] === '"') {
              // Escaped quote
              current += '"';
              i += 2;
            } else {
              // Toggle quote state
              inQuotes = !inQuotes;
              i++;
            }
          } else if (char === "," && !inQuotes) {
            // End of field
            result.push(current.trim());
            current = "";
            i++;
          } else {
            current += char;
            i++;
          }
        }

        // Add the last field
        result.push(current.trim());
        return result;
      }

      const lines = csvContent
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0);
      if (lines.length < 2) {
        socket.emit("publish:error", {
          stage: "csv_parse",
          message: "CSV has no rows",
        });
        return;
      }
      const header = parseCSVLine(lines[0]);
      const rows = lines.slice(1).map(parseCSVLine);

      // 7) Resolve Shopify Admin API URL + token
      function buildAdminUrlFromEnv(map) {
        const direct =
          map["SHOPIFY_ADMIN_API_URL"] || map["VITE_SHOPIFY_ADMIN_API_URL"];
        if (direct && direct.trim()) return direct.trim();
        const domain =
          map["VITE_SHOPIFY_URL"] ||
          map["SHOPIFY_STORE_DOMAIN"] ||
          map["SHOPIFY_STORE_URL"] ||
          "";
        if (!domain) return null;
        const clean = domain ? domain.replace(/^https?:\/\//, "") : "";
        return `https://${clean}/admin/api/2025-07/graphql.json`;
      }
      const ADMIN_URL = buildAdminUrlFromEnv(envMap);
      const ADMIN_TOKEN =
        envMap["SHOPIFY_ADMIN_ACCESS_TOKEN"] ||
        envMap["VITE_SHOPIFY_ADMIN_ACCESS_TOKEN"] ||
        envMap["ADMIN_ACCESS_TOKEN"] ||
        "";
      if (!ADMIN_URL || !ADMIN_TOKEN) {
        socket.emit("publish:error", {
          stage: "env",
          message: "Missing Shopify Admin API URL or Access Token",
        });
        return;
      }
      const queryForMetafields = `query MetafieldDefinitions($ownerType: MetafieldOwnerType!, $first: Int) { metafieldDefinitions(ownerType: $ownerType, first: $first) { nodes { name namespace key type { name } } } }`;
      const metafieldsVariables = {
        ownerType: "COLLECTION",
        first: 5,
      };
      let existingMetaField = null;
      const data = await fetch(ADMIN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": ADMIN_TOKEN,
        },
        body: JSON.stringify({
          query: queryForMetafields,
          variables: metafieldsVariables,
        }),
      });
      existingMetaField = await data.json();
      const nodes = existingMetaField?.data?.metafieldDefinitions?.nodes || [];
      const createMetaFieldMutation = `mutation CreateMetafieldDefinition($definition: MetafieldDefinitionInput!) { metafieldDefinitionCreate(definition: $definition) { createdDefinition { id name } userErrors { field message code } } }`;
      const collectionMetafieldsVariables = {
        definition: {
          name: "Theme Types",
          namespace: "custom",
          key: "theme_types",
          description: "A list of materials used to make the product.",
          type: "single_line_text_field",
          ownerType: "COLLECTION",
          pin: true,
          access: {
            storefront: "PUBLIC_READ",
          },
        },
      };
      if (nodes.length === 0) {
        console.log("Nodes array is empty");
        const createMetaFieldMutationResponse = await fetch(ADMIN_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": ADMIN_TOKEN,
          },
          body: JSON.stringify({
            query: createMetaFieldMutation,
            variables: collectionMetafieldsVariables,
          }),
        });
        const existingMetaField = await createMetaFieldMutationResponse.json();
        console.log("createMetaFieldMutation", existingMetaField);
      } else {
        const hasThemeTypes = nodes.some(
          (node) =>
            node.name === "Theme Types" &&
            node.namespace === "custom" &&
            node.key === "theme_types"
        );

        if (hasThemeTypes) {
          console.log("Found Theme Types with correct namespace and key!");
        } else {
          console.log("Theme Types not found");
          const createMetaFieldMutationResponse = await fetch(ADMIN_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Shopify-Access-Token": ADMIN_TOKEN,
            },
            body: JSON.stringify({
              query: createMetaFieldMutation,
              variables: collectionMetafieldsVariables,
            }),
          });
          const existingMetaField =
            await createMetaFieldMutationResponse.json();
          console.log("createMetaFieldMutation", existingMetaField);
        }
      }

      async function shopifyGraphQL(query, variables) {
        const rsp = await fetch(ADMIN_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": ADMIN_TOKEN,
          },
          body: JSON.stringify({ query, variables }),
        });
        if (!rsp.ok) {
          throw new Error(`GraphQL HTTP error ${rsp.status} ${rsp.statusText}`);
        }
        return rsp.json();
      }

      async function stagedUploadImage(imageSrc) {
        const stagedMutation = `
          mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
            stagedUploadsCreate(input: $input) {
              stagedTargets { url resourceUrl parameters { name value } }
              userErrors { field message }
            }
          }
        `;
        const input = [
          {
            resource: "IMAGE",
            filename: "collection-image.jpg",
            mimeType: "image/jpeg",
            httpMethod: "POST",
          },
        ];
        const staged = await shopifyGraphQL(stagedMutation, { input });
        const targets = staged?.data?.stagedUploadsCreate?.stagedTargets;
        if (!Array.isArray(targets) || targets.length === 0)
          throw new Error("No staged target returned");
        const { url, resourceUrl, parameters } = targets[0];
        if (!url || !resourceUrl || !parameters)
          throw new Error("Incomplete staged upload target");
        const form = new FormData();
        for (const p of parameters) form.append(p.name, p.value);
        const imgRsp = await fetch(imageSrc);
        if (!imgRsp.ok)
          throw new Error(`Failed to fetch image: ${imgRsp.status}`);
        const blob = await imgRsp.blob();
        form.append("file", blob, "collection-image.jpg");
        const uploadRsp = await fetch(url, { method: "POST", body: form });
        if (!uploadRsp.ok)
          throw new Error(`Failed staged upload: ${uploadRsp.status}`);
        return resourceUrl;
      }

      const collectionCreateMutation = `
        mutation CollectionCreate($input: CollectionInput!) {
          collectionCreate(input: $input) {
            collection { id title handle }
            userErrors { field message }
          }
        }
      `;

      const publishCollectionMutation = `
 mutation PublishablePublish($collectionId: ID!, $publicationId: ID!) {
    publishablePublish(id: $collectionId, input: {publicationId: $publicationId}) {
      publishable {
        publishedOnPublication(publicationId: $publicationId)
      }
      userErrors {
        field
        message
      }
    }
  }
    `;

      const publicationsQuery = `
        query GetPublications {
          publications(first: 250) {
            edges {
              node { id name }
            }
          }
        }
      `;

      // 8) Fetch publications and resolve selected publications
      let publicationEdges = [];
      try {
        const pubs = await shopifyGraphQL(publicationsQuery, {});
        publicationEdges = pubs?.data?.publications?.edges || [];
      } catch (e) {
        socket.emit("publish:error", {
          stage: "publications",
          message: e?.message || String(e),
        });
        return;
      }

      const allPublicationIds = publicationEdges
        .map((e) => e?.node?.id)
        .filter(Boolean);
      const allPublicationNames = publicationEdges
        .map((e) => e?.node?.name)
        .filter(Boolean);

      // Client may send selected publication names; if not, publish to all
      const selectedPublicationNames = Array.isArray(
        payload?.selectedPublicationNames
      )
        ? payload.selectedPublicationNames.filter(
            (n) => typeof n === "string" && n.trim().length > 0
          )
        : allPublicationNames;

      const nameToId = new Map(
        publicationEdges.map((e) => [e?.node?.name, e?.node?.id])
      );
      const selectedPublicationIds = selectedPublicationNames
        .map((n) => nameToId.get(n))
        .filter((id) => typeof id === "string" && id.length > 0);

      // Fallback: if none resolved, use all
      const publicationIdsToUse =
        selectedPublicationIds.length > 0
          ? selectedPublicationIds
          : allPublicationIds;

      // 9) Group rows by handle first, then create collections
      const collections = {};

      // First pass: Group all rows by handle
      for (const [, row] of rows.entries()) {
        const record = {};
        header.forEach((key, idx) => {
          record[key] = row[idx] ?? "";
        });

        // Skip rows without essential data
        if (!record.handle) {
          continue;
        }

        // Normalize type/column
        const column = record?.type.toUpperCase().replace(/\s+/g, "_");
        const normalizedColumn = column.startsWith("VARAINT_")
          ? column.replace(/^VARAINT_/, "VARIANT_")
          : column;

        // Normalize operator/relation
        const relation = record?.operator.toUpperCase().replace(/\s+/g, "_");

        // Condition/value
        const condition = record?.value;

        // Build rule object
        const rule = {
          column: normalizedColumn,
          relation: relation,
          condition: condition,
        };

        // Use handle as unique key for collections
        const handle = record.handle;

        if (!collections[handle]) {
          collections[handle] = {
            title: record.title,
            description: record.description,
            handle: handle,
            match_any: record.match_any === "true",
            image_src: record.image_src,
            rules: [], // initialize empty rules array
          };
        }

        // Push rule into that handle's rules array
        collections[handle].rules.push(rule);
      }

      // Convert to array for processing
      const collectionsArray = Object.values(collections);
      let createdCount = 0;

      // Second pass: Create collections with grouped rules
      for (const [i, collection] of collectionsArray.entries()) {
        const rules = collection?.rules;
        const handle = collection?.handle;
        const title = collection?.title;
        const description = collection?.description;
        const image_src = collection?.image_src;
        const appliedDisjunctively = collection?.match_any;

        // Build collectionInput exactly as requested
        const collectionInput = {
          title: title,
          handle: handle,
          descriptionHtml: description || "Collection created from CSV import",
          sortOrder: "BEST_SELLING",
          ruleSet: { appliedDisjunctively, rules },
          image_src: image_src,
          metafields: [
            {
              namespace: "custom",
              key: "theme_types",
              value: envMap["VITE_STORE_NAME"] || storeName,
              type: "single_line_text_field",
            },
          ],
        };

        // Image staged upload if image_src exists (map to input.image for GraphQL)
        if (collectionInput.image_src) {
          try {
            socket.emit("publish:collections:progress", {
              index: i,
              stage: "image_staged_upload",
              handle: handle,
              title: title,
            });
            const resourceUrl = await stagedUploadImage(
              collectionInput.image_src
            );
            collectionInput.image = {
              src: resourceUrl,
              altText: title || "",
            };
          } catch (e) {
            socket.emit("publish:collections:error", {
              index: i,
              title: title,
              handle: handle,
              message: e?.message || String(e),
            });
            continue;
          }
        }

        try {
          socket.emit("publish:collections:progress", {
            index: i,
            stage: "create_mutation",
            handle: handle,
            title: title,
          });
          const result = await shopifyGraphQL(collectionCreateMutation, {
            input: collectionInput,
          });
          const userErrors = result?.data?.collectionCreate?.userErrors || [];
          if (userErrors.length) {
            // Attempt recovery when handle already exists: fetch by title, append store to metafield, update collection
            try {
              const errorMessages = userErrors
                .map((e) => e?.message || "")
                .join(" | ");
              const isHandleTaken =
                /handle/i.test(errorMessages) &&
                /taken|already/i.test(errorMessages);

              const getCollectionsByTitleQuery = `
                query($handle: String!) { collections(first: 10, query: $handle) { edges { node { id title handle updatedAt metafields(first: 10) { edges { node { id namespace key type value } } } } } } }
              `;
              const handleQuery = `handle:'${
                handle ? handle.replace(/'/g, "\\'") : ""
              }'`;
              const existing = await shopifyGraphQL(
                getCollectionsByTitleQuery,
                {
                  handle: handleQuery,
                }
              );
              const existingEdges = existing?.data?.collections?.edges || [];
              const existingNode = existingEdges?.[0]?.node;

              if (existingNode?.id) {
                // Read current metafield value
                const existingMetaEdges = existingNode?.metafields?.edges || [];
                const themeTypesNode = existingMetaEdges
                  .map((e) => e?.node)
                  .find(
                    (n) => n?.namespace === "custom" && n?.key === "theme_types"
                  );
                const currentValue = (themeTypesNode?.value || "").trim();
                const currentParts = currentValue
                  ? currentValue
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean)
                  : [];
                const currentStore = envMap["VITE_STORE_NAME"] || storeName;
                if (!currentParts.includes(currentStore))
                  currentParts.push(currentStore);
                const mergedValue = currentParts.join(", ");

                const updateCollectionMetafieldsMutation = `
                  mutation updateCollectionMetafields($input: CollectionInput!) {
                    collectionUpdate(input: $input) {
                      collection {
                        id
                        metafields(first: 3) { edges { node { id namespace key value } } }
                      }
                      userErrors { message field }
                    }
                  }
                `;

                const updateResult = await shopifyGraphQL(
                  updateCollectionMetafieldsMutation,
                  {
                    input: {
                      id: existingNode.id,
                      metafields: [
                        {
                          namespace: "custom",
                          key: "theme_types",
                          type: "single_line_text_field",
                          value: mergedValue,
                        },
                      ],
                    },
                  }
                );

                const updErrors =
                  updateResult?.data?.collectionUpdate?.userErrors || [];
                if (updErrors.length) {
                  socket.emit("publish:collections:error", {
                    index: i,
                    title: title,
                    handle: handle,
                    message: `update_failed: ${JSON.stringify(updErrors)}`,
                  });
                  continue;
                }
                socket.emit("publish:collections:progress", {
                  index: i,
                  title: title,
                  id: existingNode.id,
                  handle: handle,
                });

                // Consider this collection processed successfully after update
                createdCount++;
                socket.emit("publish:collections:published", {
                  index: i,
                  title: title,
                  id: existingNode.id,
                  handle: handle,
                });
                continue;
              }

              // If we couldn't find existing collection, report original error
              socket.emit("publish:collections:error", {
                index: i,
                title: title,
                handle: handle,
                message: "collection_not_found_by_title",
              });
              socket.emit("publish:collections:error", {
                index: i,
                title: title,
                handle: handle,
                message: JSON.stringify(userErrors),
              });
              continue;
            } catch (recoveryError) {
              socket.emit("publish:collections:error", {
                index: i,
                title: title,
                handle: handle,
                message: recoveryError?.message || String(recoveryError),
              });
              socket.emit("publish:collections:error", {
                index: i,
                title: title,
                handle: handle,
                message: `recovery_failed: ${
                  recoveryError?.message || String(recoveryError)
                }`,
              });
              continue;
            }
          }
          const collectionData = result?.data?.collectionCreate?.collection;

          // Optionally publish to sales channels (publications)
          if (collectionData?.id && publicationIdsToUse.length > 0) {
            const failedPublications = [];
            for (const publicationId of publicationIdsToUse) {
              try {
                socket.emit("publish:collections:publishing", {
                  index: i,
                  title: title,
                  collectionId: collectionData?.id,
                  publicationId,
                });
                const pubResult = await shopifyGraphQL(
                  publishCollectionMutation,
                  {
                    collectionId: collectionData?.id,
                    publicationId: publicationId,
                  }
                );
                const pubErrors =
                  pubResult?.data?.publishablePublish?.userErrors || [];
                if (pubErrors.length) {
                  const msg = pubErrors
                    .map((e) => `${e.field || "unknown"}: ${e.message}`)
                    .join(", ");
                  failedPublications.push({ id: publicationId, error: msg });
                  socket.emit("publish:collections:publish_error", {
                    index: i,
                    title: title,
                    collectionId: collectionData?.id,
                    handle: handle,
                    publicationId,
                    message: msg,
                  });
                } else {
                  socket.emit("publish:collections:published", {
                    index: i,
                    title: title,
                    handle: handle,
                    collectionId: collectionData?.id,
                    publicationId,
                  });
                }
              } catch (e) {
                const msg = e?.message || String(e);
                failedPublications.push({ id: publicationId, error: msg });
                socket.emit("publish:collections:publish_error", {
                  index: i,
                  title: title,
                  collectionId: collectionData?.id,
                  publicationId,
                  message: msg,
                });
              }
            }
            socket.emit("publish:collections:publish_summary", {
              index: i,
              title: title,
              collectionId: collectionData?.id,
              failed: failedPublications,
            });
          }

          createdCount++;
          socket.emit("publish:collections:success", {
            index: i,
            title: title,
            id: collectionData?.id,
            handle: handle,
          });
        } catch (e) {
          console.log(e.message);
          socket.emit("publish:collections:error", {
            index: i,
            title: title,
            handle: handle,
            message: e?.message || String(e),
          });
        }
      }

      socket.emit("publish:collections:done", {
        created: createdCount,
        total: collectionsArray.length,
      });
      // Kick off products step automatically
      socket.emit("publish:collections:completed", {
        storeName,
        success: true,
      });
    } catch (error) {
      console.log("error:", error.message);
      socket.emit("publish:error", {
        stage: "unexpected",
        message: error?.message || String(error),
      });
    }
  });
  socket.on("publish:products", async (payload, publications) => {
    uploadProducts(payload, publications);
  });
  async function uploadProducts(message, publications) {
    const payload = JSON.parse(message);

    try {
      if (!payload?.storeName) {
        console.error("[UploadProducts] Missing storeName in payload");
        socket.emit("publish:error", {
          message: "Missing storeName in payload",
        });
        return;
      }

      const storeName = payload.storeName.trim();
      console.log(`[UploadProducts] Starting for store: ${storeName}`);

      // Load .env
      const envPath = path.join("./" + storeName, ".env");
      if (!fs.existsSync(envPath)) {
        console.error(`[UploadProducts] .env file not found: ${envPath}`);
        socket.emit("publish:error", {
          message: ".env file not found",
          envPath,
        });
        return;
      }

      const envMap = {};
      fs.readFileSync(envPath, "utf8")
        .split(/\r?\n/)
        .forEach((line) => {
          if (!line || line.startsWith("#")) return;
          const [key, ...rest] = line.split("=");
          if (!key) return;
          envMap[key.trim()] = rest.join("=").trim().replace(/^"|"$/g, "");
        });

      function buildAdminUrlFromEnv(map) {
        const direct =
          map["SHOPIFY_ADMIN_API_URL"] || map["VITE_SHOPIFY_ADMIN_API_URL"];
        if (direct && direct.trim()) return direct.trim();
        const domain =
          map["VITE_SHOPIFY_URL"] ||
          map["SHOPIFY_STORE_DOMAIN"] ||
          map["SHOPIFY_STORE_URL"] ||
          "";
        if (!domain) return null;
        const clean = domain.replace(/^https?:\/\//, "");
        return `https://${clean}/admin/api/2025-07/graphql.json`;
      }

      const ADMIN_URL = buildAdminUrlFromEnv(envMap);
      const ADMIN_TOKEN =
        envMap["SHOPIFY_ADMIN_ACCESS_TOKEN"] ||
        envMap["VITE_SHOPIFY_ADMIN_ACCESS_TOKEN"];

      if (!ADMIN_URL || !ADMIN_TOKEN) {
        console.error("[UploadProducts] Missing Shopify credentials");
        socket.emit("publish:error", {
          message: "Missing Shopify credentials",
        });
        return;
      }

      console.log(`[UploadProducts] Using Shopify API: ${ADMIN_URL}`);

      // GraphQL helper
      async function shopifyGraphQL(query, variables) {
        const rsp = await fetch(ADMIN_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": ADMIN_TOKEN,
          },
          body: JSON.stringify({ query, variables }),
        });
        if (!rsp.ok) throw new Error(`GraphQL HTTP error ${rsp.status}`);
        return rsp.json();
      }

      async function ensureThemeTypesDefinition(ownerType = "PRODUCT") {
        const queryForMetafields = `
        query MetafieldDefinitions($ownerType: MetafieldOwnerType!, $first: Int) {
          metafieldDefinitions(ownerType: $ownerType, first: $first) {
            nodes { name namespace key type { name } }
          }
        }`;

        const resp = await shopifyGraphQL(queryForMetafields, {
          ownerType,
          first: 20,
        });

        const nodes = resp?.data?.metafieldDefinitions?.nodes || [];
        const hasThemeTypes = nodes.some(
          (node) => node.namespace === "custom" && node.key === "theme_types"
        );

        if (hasThemeTypes) {
          console.log(
            `[UploadProducts] ✅ Metafield definition already exists for ${ownerType}`
          );
          return;
        }

        console.log(
          `[UploadProducts] ⚠️ Creating metafield definition for ${ownerType}`
        );

        const createMetaFieldMutation = `
        mutation CreateMetafieldDefinition($definition: MetafieldDefinitionInput!) {
          metafieldDefinitionCreate(definition: $definition) {
            createdDefinition { id name }
            userErrors { field message code }
          }
        }`;

        const createResp = await shopifyGraphQL(createMetaFieldMutation, {
          definition: {
            name: "Theme Types",
            namespace: "custom",
            key: "theme_types",
            description: "A theme type reference for store products",
            type: "single_line_text_field",
            ownerType,
            pin: true,
            access: { storefront: "PUBLIC_READ" },
          },
        });

        if (createResp?.data?.metafieldDefinitionCreate?.userErrors?.length) {
          console.error(
            "[UploadProducts] ❌ Error creating metafield definition:",
            createResp.data.metafieldDefinitionCreate.userErrors
          );
        } else {
          console.log("[UploadProducts] ✅ Created metafield definition");
        }
      }

      // Ensure product metafield definition exists
      await ensureThemeTypesDefinition("PRODUCT");

      // Parse CSV
      const themeFolderPath = path.resolve(
        `./${envMap["VITE_CATEGORY"]}_${envMap["VITE_LANGUAGE"]}`
      );
      const csvFiles = fs
        .readdirSync(themeFolderPath)
        .filter((f) => f.toLowerCase().endsWith(".csv"));
      const productCsv = csvFiles.find((f) =>
        f.toLowerCase().includes("product")
      );
      if (!productCsv) {
        console.error(
          `[UploadProducts] Products CSV not found in: ${themeFolderPath}`
        );
        socket.emit("publish:error", {
          message: "Products CSV not found",
          themeFolderPath,
        });
        return;
      }

      const fileContent = fs.readFileSync(
        path.join(themeFolderPath, productCsv),
        "utf8"
      );
      const records = parse(fileContent, { skip_empty_lines: true });
      const header = records[0];
      const rows = records.slice(1);

      console.log(`[UploadProducts] CSV contains ${rows.length} product rows`);

      // Fetch location once
      const locationResp = await shopifyGraphQL(
        `query { locations(first: 5) { edges { node { id } } } }`
      );
      const locationId =
        locationResp?.data?.locations?.edges?.[0]?.node?.id || null;
      console.log(`[UploadProducts] Using locationId: ${locationId}`);

      // Group products by handle
      const groupedProducts = new Map();
      rows.forEach((row) => {
        const data = {};
        header.forEach((h, i) => {
          if (row[i] && row[i].trim()) data[h] = row[i].trim();
        });
        const handle = data["Handle"];
        if (!handle) return;
        if (!groupedProducts.has(handle)) {
          groupedProducts.set(handle, {
            baseRow: { ...data },
            variants: [],
            media: [],
          });
        }
        const group = groupedProducts.get(handle);

        if (data["Image Src"]) {
          group.media.push({
            originalSource: data["Image Src"],
            alt: data["Image Alt Text"] || `Media for ${handle}`,
            contentType: "IMAGE",
          });
        }

        const optionValues = [];
        ["1", "2", "3"].forEach((n) => {
          const optName =
            data[`Option${n} Name`] || group.baseRow[`Option${n} Name`];
          const optValue = data[`Option${n} Value`];
          if (optName && optValue)
            optionValues.push({ optionName: optName, name: optValue });
        });

        if (optionValues.length || data["Variant SKU"]) {
          group.variants.push({
            price: data["Variant Price"]?.toString() || "10.00",
            inventoryPolicy: (
              data["Variant Inventory Policy"] || "CONTINUE"
            ).toUpperCase(),
            taxable: data["Variant Taxable"]?.toUpperCase() === "TRUE",
            optionValues,
            inventoryQuantities: data["Variant Inventory Qty"]
              ? [
                  {
                    locationId: locationId, // to be filled later
                    quantity: Number(data["Variant Inventory Qty"]),
                    name: "available",
                  },
                ]
              : [],
            sku: data["Variant SKU"]?.toString(),
          });
        }
      });

      console.log(
        `[UploadProducts] Grouped into ${groupedProducts.size} products`
      );

      let createdCount = 0;

      // Loop over products
      for (const [handle, group] of groupedProducts) {
        try {
          console.log(`[UploadProducts] Creating product: ${handle}`);

          const product = group.baseRow;
          const optionNames = ["1", "2", "3"]
            .map((n) => group.baseRow[`Option${n} Name`])
            .filter(Boolean);

          const derivedProductOptions = optionNames.map((optName) => {
            const values = Array.from(
              new Set(
                group.variants
                  .flatMap((v) =>
                    v.optionValues
                      .filter((ov) => ov.optionName === optName)
                      .map((ov) => ov.name)
                  )
                  .filter(Boolean)
              )
            );
            return { name: optName, values: values.map((v) => ({ name: v })) };
          });

          const inputPayload = {
            synchronous: true,
            productSet: {
              title: product.Title || handle,
              descriptionHtml: product["Body (HTML)"] || "",
              vendor: product.Vendor || "Default Vendor",
              productType: product["Type"] || "General",
              status: (product["Status"] || "ACTIVE").toUpperCase(),
              seo: {
                title: product["SEO Title"] || product.Title,
                description: product["SEO Description"] || "",
              },
              tags: product["Tags"] || "",
              productOptions: derivedProductOptions,
              // metafields: [
              //   {
              //     namespace: "custom",
              //     key: "theme_types",
              //     value: payload?.publications
              //       ?.map((publication) =>
              //         publication.publicationName.split(" ").join("-")
              //       )
              //       .join(","),
              //     type: "single_line_text_field",
              //   },
              // ],
              variants: group.variants.map((v) => {
                v.inventoryQuantities.forEach(
                  (iq) => (iq.locationId = locationId)
                );
                return v;
              }),
              files: group.media,
            },
          };

          const createResp = await shopifyGraphQL(
            `
          mutation createProductAsynchronous($productSet: ProductSetInput!, $synchronous: Boolean!) {
            productSet(synchronous: $synchronous, input: $productSet) {
                      product {
            id
            title
             media(first: 5) {
            nodes {
              id
              alt
              mediaContentType
              status
            }
          }
            variants(first: 10) {
              edges {
                node {
                  id
                  title
                  inventoryItem {
                    id  # 👈 This is needed to adjust inventory later
                  }
                }
              }
            }
          }
          productSetOperation {
            id
            status
            userErrors {
              code
              field
              message
            }
          }
          userErrors {
            code
            field
            message
          }
        }
          }`,
            inputPayload
          );

          const createdProduct = createResp?.data?.productSet?.product;
          const inventoryItemId =
            createResp?.data?.productSet?.product?.variants?.edges[0]?.node
              ?.inventoryItem?.id;
          if (!createdProduct?.id) {
            console.error(
              `[UploadProducts] Failed for ${handle}:`,
              createResp?.data?.productSet?.userErrors
            );
            socket.emit("publish:error", {
              handle,
              message: JSON.stringify(createResp?.data?.productSet?.userErrors),
            });
            continue;
          }

          const updateItemMutation = `mutation inventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
      inventoryItemUpdate(id: $id, input: $input) {
        inventoryItem {
          id
          unitCost {
            amount
          }
          tracked
          countryCodeOfOrigin
          provinceCodeOfOrigin
          harmonizedSystemCode
          countryHarmonizedSystemCodes(first: 1) {
            edges {
              node {
                harmonizedSystemCode
                countryCode
              }
            }
          }
        }
        userErrors {
          message
        }
      }
    }`;

          const inventoryUpdateResponse = await fetch(ADMIN_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Shopify-Access-Token": ADMIN_TOKEN,
            },
            body: JSON.stringify({
              query: updateItemMutation,
              variables: {
                id: inventoryItemId,
                input: {
                  tracked: true,
                },
              },
            }),
          });

          const inventoryUpdated = await inventoryUpdateResponse.json();

          console.log(
            `[UploadProducts] ✅ Created product: ${createdProduct.title} (${createdProduct.id})`
          );

          createdCount++;
          socket.emit("publish:success", {
            handle,
            id: createdProduct.id,
            count: createdCount,
            title: createdProduct.title,
          });

          for (const publication of payload?.publications) {
            try {
              const publishResponse = await fetch(ADMIN_URL, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "X-Shopify-Access-Token": ADMIN_TOKEN,
                },
                body: JSON.stringify({
                  query: `
                    mutation PublishablePublish($productId: ID!, $publicationId: ID!) {
                      publishablePublish(id: $productId, input: {publicationId: $publicationId}) {
                        publishable {
                          publishedOnPublication(publicationId: $publicationId)
                        }
                        userErrors {
                          field
                          message
                        }
                      }
                    }`,
                  variables: {
                    productId: createdProduct?.id,
                    publicationId: publication.publicationId,
                  },
                }),
              });

              const publishData = await publishResponse.json();

              if (publishData.data.publishablePublish.userErrors.length > 0) {
                console.error(
                  "Publishing failed for",
                  product["Title"],
                  "on publication",
                  publication.publicationName,
                  ":",
                  publishData.data.publishablePublish.userErrors
                );
              } else {
                console.log(
                  "✅ Successfully created and published:",
                  product["Title"],
                  "on publication:",
                  publication.publicationName
                );
              }
            } catch (error) {
              console.error(
                "Error publishing product:",
                product["title"],
                "on publication:",
                publication.publicationName,
                error
              );
            }
          }
        } catch (err) {
          console.error(`[UploadProducts] ❌ Error for ${handle}:`, err);
          socket.emit("publish:error", {
            handle: group.baseRow.Handle,
            message: err?.message || String(err),
          });
        }
      }
    } catch (err) {
      console.error("[UploadProducts] Fatal error:", err);
      socket.emit("publish:error", { message: err?.message || String(err) });
    }
  }
};
