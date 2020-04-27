const debugModule = require("debug");
debugModule.enable("*");
const debug = debugModule("sonos_to_mqtt");

const _ = require("lodash");
const mqtt = require("mqtt");
const config = require("config");
const fetch = require("node-fetch");
const { URLSearchParams } = require("url");

const mqttConfig = config.get("mqtt");
const sonosConfig = config.get("sonos");

const SONOS_AUTH_SERVER = "https://api.sonos.com";
const SONOS_API_SERVER = "https://api.ws.sonos.com";

function onMqttMessage(topic, message) {
  if (topic in mqttTopics) {
    const fn = mqttTopics[topic];
    fn(message);
  } else {
    debug("received message on unknown mqtt topic", topic);
  }
}

async function mqttSubscribe(topic, fn) {
  return new Promise((resolve, reject) => {
    mqttTopics[topic] = fn;

    mqttClient.subscribe(topic, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

async function connectToMQTT() {
  debug("Connecting to MQTT...");
  mqttClient = mqtt.connect(mqttConfig.brokerAddress, {
    clientId: mqttConfig.clientId,
  });
  mqttClient.on("message", onMqttMessage);

  await new Promise((resolve, reject) => {
    mqttClient.on("error", reject);
    mqttClient.on("connect", () => resolve());
  });

  debug("Connected to MQTT.");
}

let sonosToken = null;
async function getSonosOAuthToken_() {
  if (
    sonosToken &&
    sonosToken.grantTime + sonosToken.expires_in * 1000 - 60000 > Date.now()
  ) {
    return sonosToken.access_token;
  }

  const { refreshToken, appKey, appSecret } = sonosConfig;
  const basicToken = new Buffer.from(`${appKey}:${appSecret}`).toString(
    "base64"
  );

  const response = await fetch(`${SONOS_AUTH_SERVER}/login/v3/oauth/access`, {
    method: "POST",
    body: new URLSearchParams({
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
    headers: {
      Authorization: `Basic ${basicToken}`,
    },
  });
  const json = await response.json();

  sonosToken = json;
  sonosToken.grantTime = Date.now();
  return sonosToken.access_token;
}
const getSonosOAuthToken = () =>
  time(getSonosOAuthToken_, "getSonosOAuthToken");

async function getSonosHouseholdID() {
  const token = await getSonosOAuthToken();
  const response = await fetch(
    `${SONOS_API_SERVER}/control/api/v1/households`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  const json = await response.json();

  return json["households"][0]["id"];
}

async function getSonosGroupsAndPlayers(householdId) {
  const token = await getSonosOAuthToken();
  const response = await fetch(
    `${SONOS_API_SERVER}/control/api/v1/households/${householdId}/groups`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  const json = await response.json();

  return json;
}

async function adjustSonosGrouping(householdId, playerNames) {
  const response = await time(
    () => getSonosGroupsAndPlayers(householdId),
    "get groups"
  );
  const { groups, players } = response;

  const targetGroup = _.find(
    groups,
    (group) => group.playbackState == "PLAYBACK_STATE_PLAYING"
  );
  if (!targetGroup) {
    return null;
  }

  const targetPlayers = playerNames.map((name) =>
    findMatchingPlayerId(players, name)
  );

  const playerIdsToAdd = _.difference(targetPlayers, targetGroup.playerIds);
  const playerIdsToRemove = _.difference(targetGroup.playerIds, targetPlayers);
  if (playerIdsToAdd.length == 0 && playerIdsToRemove.length == 0) {
    return null;
  }

  const token = await getSonosOAuthToken();
  const setResponse = await time(
    () =>
      fetch(
        `${SONOS_API_SERVER}/control/api/v1/groups/${targetGroup.id}/groups/setGroupMembers`,
        {
          method: "POST",
          body: JSON.stringify({
            playerIds: targetPlayers,
          }),
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        }
      ),
    `set group (+${playerIdsToAdd.length}, -${playerIdsToRemove.length})`
  );

  const setResponseJson = await setResponse.json();
  return setResponseJson;
}

function findMatchingPlayerId(players, name) {
  const result = _.find(
    players,
    (player) => player.name.toLowerCase() == name.toLowerCase()
  );

  return result.id;
}

async function time(fn, memo) {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    const end = Date.now();
    debug(`${memo} took ${end - start}ms`);
  }
}

async function main() {
  const householdId = await time(() => getSonosHouseholdID(), "get household");
  const adjustResult = await adjustSonosGrouping(householdId, ["bedroom"]);
}

main();
