"use strict";
const env = require("./env.json");
Object.assign(process.env, env);

const ethers = require("ethers");
const retry = require("async-retry");
const tokens = require("./tokens.js");

const purchaseAmount = ethers.utils.parseUnits(tokens.purchaseAmount, "ether");
const pcsAbi = new ethers.utils.Interface(require("./abi.json"));
const EXPECTED_PONG_BACK = 30000;
const KEEP_ALIVE_CHECK_INTERVAL = 15000;
let pingTimeout = null;
let keepAliveInterval = null;
let provider;
let wallet;
let account;
let router;
let shotsFired = 0;

const startConnection = () => {
  provider = new ethers.providers.WebSocketProvider(process.env.BSC_NODE_WSS);
  wallet = new ethers.Wallet(process.env.PRIVATE_KEY);
  account = wallet.connect(provider);
  router = new ethers.Contract(tokens.router, pcsAbi, account);

  provider._websocket.on("open",async () => {
    if (approved === 0) {
      await Approve();
    }
    throbber = ora({
      text: "Waiting for the dxsale to finalize...",
      spinner: {
        frames: ["ðŸŠ", "ðŸ¢", "ðŸ¦Ž", "ðŸ"],
        interval: 300, // Optional
      },
    }).start();
    keepAliveInterval = setInterval(() => {
      provider._websocket.ping();
      // Use `WebSocket#terminate()`, which immediately destroys the connection,
      // instead of `WebSocket#close()`, which waits for the close timer.
      // Delay should be equal to the interval at which your server
      // sends out pings plus a conservative assumption of the latency.
      pingTimeout = setTimeout(() => {
        provider._websocket.terminate();
      }, EXPECTED_PONG_BACK);
    }, KEEP_ALIVE_CHECK_INTERVAL);

    provider.on("pending", async (txHash) => {
      if (shotsFired === 0) {
        provider
          .getTransaction(txHash)
          .then(async (tx) => {
            if (tx && tx.to) {
              if (
                tx.to === 
                ethers.utils.getAddress(
                  "0x7100c01f668a5b407db6a77821ddb035561f25b8"
                ) 
              ) {
                const re = new RegExp("^0x267dd102");
                if (re.test(tx.data)) {
                  if (tx.from === ethers.utils.getAddress(devWallet)) {
                    shotsFired = 1;
                    throbber.stop();
                    await BuyToken(tx);
                    process.exit(); // shouldn't ever get here
                  }
                }
              }
            }
          })
          .catch(() => {});
      }
    });
  });

  provider._websocket.on("close", () => {
    console.log("WebSocket Closed...Reconnecting...");
    clearInterval(keepAliveInterval);
    clearTimeout(pingTimeout);
    startConnection();
  });

  provider._websocket.on("error", () => {
    console.log("Error. Attemptiing to Reconnect...");
    clearInterval(keepAliveInterval);
    clearTimeout(pingTimeout);
    startConnection();
  });

  provider._websocket.on("pong", () => {
    clearInterval(pingTimeout);
  });
};

const BuyToken = async (txLP) => {
  const tx = await retry(
    async () => {
      const amountOutMin = 0; // I don't like this but it works
      let buyConfirmation =
        await router.swapExactETHForTokensSupportingFeeOnTransferTokens(
          amountOutMin,
          tokens.pair,
          process.env.RECIPIENT,
          Date.now() + 1000 * 60 * 1, //1 minute
          {
            value: purchaseAmount,
            gasLimit: tokens.gasLimit,
            gasPrice: ethers.utils.parseUnits(tokens.gasPrice, "gwei"),
          }
        );
      return buyConfirmation;
    },
    {
      retries: tokens.buyRetries,
      minTimeout: tokens.retryMinTimeout,
      maxTimeout: tokens.retryMaxTimeout,
      onRetry: (err, number) => {
        console.log("Buy Failed - Retrying", number);
        console.log("Error", err);
        if (number === tokens.buyRetries) {
          console.log("Sniping has failed...");
          process.exit();
        }
      },
    }
  );
  console.log("Waiting for Transaction receipt...");
  const receipt = await tx.wait();
  console.log("Token Purchase Complete");
  console.log("Associated LP Event txHash: " + txLP.hash);
  console.log("Your txHash: " + receipt.transactionHash);
  process.exit();
};
startConnection();
