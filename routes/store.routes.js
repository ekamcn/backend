const express = require("express");
const router = express.Router();
const storeController = require("../controllers/storeController");

router.get("/", storeController.getStoreByName);
router.get("/all", storeController.getAllStores);
router.get("/publicationId", storeController.getPublicationByStoreName);
router.get("/env", storeController.getStoreEnvByName);
router.post("/delete", storeController.deleteStoreByName);
router.post("/google-scripts", storeController.updateGoogleScripts);

module.exports = router;
