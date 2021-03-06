const appRoot = require('app-root-path');
const _ = require('lodash');
const oracledb = require('oracledb');
const decamelize = require('decamelize');

const { serializePlayers, serializePlayer } = require('../../serializers/players-serializer');
const { validateGame } = require('./game-dao');

const conn = appRoot.require('api/v1/db/oracledb/connection');


const sqlQuery = `
  SELECT P.PLAYER_ID,
         P.MEMBER_ID,
         M.MEMBER_NICKNAME,
         M.MEMBER_LEVEL,
         M.MEMBER_EXP_OVER_LEVEL,
         P.PLAYER_BET,
         S.STATUS AS PLAYER_STATUS,
         CN.CARD_NUMBER,
         CS.SUIT
  FROM PLAYERS P
  INNER JOIN GAMES G ON G.GAME_ID = P.GAME_ID
  INNER JOIN STATUSES S ON S.STATUS_ID = P.STATUS_ID
  INNER JOIN MEMBERS M ON M.MEMBER_ID = P.MEMBER_ID
  LEFT OUTER JOIN PLAYER_CARDS PC ON PC.PLAYER_ID = P.PLAYER_ID
  LEFT OUTER JOIN CARDS C ON PC.CARD_ID = C.CARD_ID
  LEFT OUTER JOIN CARD_NUMBERS CN ON C.CARD_NUMBER_ID = CN.CARD_NUMBER_ID
  LEFT OUTER JOIN CARD_SUITS CS ON C.CARD_SUIT_ID = CS.SUIT_ID
  `;

/**
 *
 * @param {number} id Id of the game.
 * @param {object} query Query object sent from the client.
 * @returns {Promise<object>} The promise object of the data returned from data source.
 */
const getPlayersByGameId = async (id, query) => {
  const connection = await conn.getConnection();
  try {
    const sqlParams = [id];
    if (!(await validateGame(id))) {
      return undefined;
    }
    const getSqlQuery = `
      ${sqlQuery}
      WHERE G.GAME_ID = :id
      `;
    const rawPlayersResponse = await connection.execute(getSqlQuery, sqlParams);
    const rawPlayers = rawPlayersResponse.rows;
    const serializedPlayers = serializePlayers(rawPlayers, query, id);
    return serializedPlayers;
  } finally {
    connection.close();
  }
};

/**
 *
 * @param {number} id The id of the game.
 * @param {number} pid The id of the player.
 * @param {boolean} isPost Whether this function is being used by a post operation function.
 * @returns {Promise<object>} The promise object of data returned from data source.
 */
const getPlayerByGameIdAndPlayerId = async (id, pid, isPost = false) => {
  const connection = await conn.getConnection();
  try {
    const sqlParams = [id, pid];
    const getSqlQuery = `${sqlQuery}
      WHERE G.GAME_ID = :id
      AND P.PLAYER_ID = :pid
      `;
    const rawPlayersResponse = await connection.execute(getSqlQuery, sqlParams);
    const rawPlayers = rawPlayersResponse.rows;
    const groupedRawPlayers = _.groupBy(rawPlayers, 'GAME_ID');
    if (_.isEmpty(groupedRawPlayers)) {
      return undefined;
    }
    if (_.keys(groupedRawPlayers).length > 1) {
      throw new Error('Expect a single object but got multiple results.');
    } else {
      const serializedPlayer = serializePlayer(rawPlayers, id, isPost);
      return serializedPlayer;
    }
  } finally {
    connection.close();
  }
};

/**
 *
 * @param {number} playerId Id of the player.
 * @param {object} connection Connection object passed from another function.
 * @returns {Promise<object>} Promise object of the result object from data source.
 */
const cleanPlayerCardsByPlayerId = async (playerId, connection) => {
  const sqlParams = [playerId];
  const deleteSqlQuery = `
    DELETE FROM PLAYER_CARDS WHERE PLAYER_ID = :playerId
  `;
  const result = await connection.execute(deleteSqlQuery, sqlParams);
  return result;
};

/**
 *
 * @param {number} playerId Id of the player
 * @param {object} passedConnection Connection object passed from another function.
 * @returns {Promise<object>} Promise object of the result object from data source.
 */
const deletePlayerByPlayerId = async (playerId, passedConnection) => {
  const isPassedConnection = Boolean(passedConnection);
  const connection = isPassedConnection ? passedConnection : await conn.getConnection();
  try {
    await cleanPlayerCardsByPlayerId(playerId, connection);
    const sqlParams = [playerId];
    const deleteSqlQuery = `
      DELETE FROM PLAYERS WHERE PLAYER_ID = :playerId
    `;
    const result = await connection.execute(deleteSqlQuery, sqlParams,
      { autoCommit: !isPassedConnection });
    return result;
  } finally {
    if (!isPassedConnection) {
      connection.close();
    }
  }
};

/**
 *
 * @param {number} memberId Id of the member.
 * @param {object} connection Connection object passed from another function.
 */
const deletePlayersByMemberId = async (memberId, connection) => {
  const sqlParams = [memberId];
  const playerSqlQuery = `
    SELECT PLAYER_ID FROM PLAYERS P
    WHERE MEMBER_ID = :memberId
    `;
  const deletePlayerCardSqlQuery = `
    DELETE FROM PLAYER_CARDS WHERE PLAYER_ID IN (${playerSqlQuery})`;
  await connection.execute(deletePlayerCardSqlQuery, sqlParams);

  const deletePlayersSqlQuery = `
    DELETE FROM PLAYERS WHERE PLAYER_ID IN (${playerSqlQuery})`;
  await connection.execute(deletePlayersSqlQuery, sqlParams);
};

/**
 *
 * @param {object} body body object passed from client.
 * @param {number} gameId Id of the game.
 * @returns {Promise<object>} The promise object of data returned from data source.
 */
const postPlayerByGameId = async (body, gameId) => {
  const connection = await conn.getConnection();
  try {
    body.outId = {
      type: oracledb.NUMBER,
      dir: oracledb.BIND_OUT,
    };

    const { playerCards } = body;
    delete body.playerCards;
    const postSqlQuery = `
      INSERT INTO PLAYERS (MEMBER_ID, GAME_ID, PLAYER_BET, STATUS_ID)
      VALUES (:memberId,
            ${gameId},
            :playerBet,
            (SELECT STATUS_ID FROM STATUSES WHERE STATUS = :playerStatus))
      RETURNING PLAYER_ID INTO :outId
      `;
    const rawPlayer = await connection.execute(postSqlQuery, body, { autoCommit: true });
    const playerId = rawPlayer.outBinds.outId[0];
    const cardSqlQuery = `INSERT INTO PLAYER_CARDS (PLAYER_ID, CARD_ID) VALUES
      (:playerId,
       (SELECT CARD_ID FROM CARDS C
        INNER JOIN CARD_SUITS CS ON CS.SUIT_ID = C.CARD_SUIT_ID
        INNER JOIN CARD_NUMBERS CN ON CN.CARD_NUMBER_ID = C.CARD_NUMBER_ID
        WHERE SUIT = :cardSuit AND CARD_NUMBER = :cardNumber
       )
      )`;
    const promiseArray = _.map(playerCards, (card) => {
      card.playerId = playerId;
      return connection.execute(cardSqlQuery, card, { autoCommit: true });
    });
    await Promise.all(promiseArray);

    const result = await getPlayerByGameIdAndPlayerId(gameId, playerId, true);
    return result;
  } finally {
    connection.close();
  }
};

const insertCardsByPlayerId = async (playerId, playerCards, connection) => {
  const flattenedArray = _.reduce(playerCards, (result, card) => {
    result.push(card.cardNumber);
    result.push(card.cardSuit);
    return result;
  }, []);
  const individualSelection = [];
  for (let i = 0; i < _.size(flattenedArray); i += 2) {
    individualSelection.push(`(:${i}, :${i + 1})`);
  }
  const selectBindString = _.join(individualSelection, ',');
  const getIdSqlQuery = `
    SELECT C.CARD_ID FROM CARDS C
    INNER JOIN CARD_SUITS CS ON C.CARD_SUIT_ID = CS.SUIT_ID
    INNER JOIN CARD_NUMBERS CN ON C.CARD_NUMBER_ID = CN.CARD_NUMBER_ID
    WHERE (CN.CARD_NUMBER, CS.SUIT) IN (${selectBindString})`;
  const cardIdResult = await connection.execute(getIdSqlQuery, flattenedArray);
  const cardIds = _.map(cardIdResult.rows, card => card.CARD_ID);

  const insertBindString = cardIds.map((name, index) => `INTO PLAYER_CARDS (PLAYER_ID, CARD_ID)
  VALUES (:playerId, :${index})`).join('\n');
  const insertSqlQuery = `
    INSERT ALL
      ${insertBindString}
    SELECT 1 FROM DUAL
    `;
  const sqlParams = {
    ...cardIds,
    playerId,
  };
  await connection.execute(insertSqlQuery, sqlParams);
};

const databaseName = string => (decamelize(string).toUpperCase());

const isTruthyOrZero = val => (val || val === 0);

/**
 *
 * @param {number} playerId Id of the player.
 * @param {object} attributes The attribute object from client's body sent.
 * @returns {Promise<object>} Promise object of data returned from data source.
 */
const patchPlayer = async (playerId, attributes) => {
  const connection = await conn.getConnection();
  try {
    const { playerCards } = attributes;
    delete attributes.playerCards;
    //  Get the status ID of the playerStatus in request body.
    if (attributes.playerStatus) {
      const statusSqlQuery = `
        SELECT S.STATUS_ID FROM STATUSES S
        WHERE S.STATUS = :playerStatus
        `;
      const statusParam = [attributes.playerStatus];
      const statusResponse = await connection.execute(statusSqlQuery, statusParam);
      attributes.statusId = statusResponse.rows[0].STATUS_ID;
      delete attributes.playerStatus;
    }


    //  When playerCards is empty, simply clean the card.

    if (playerCards) {
      await cleanPlayerCardsByPlayerId(playerId, connection);
      if (!_.isEmpty(playerCards)) {
        await insertCardsByPlayerId(playerId, playerCards, connection);
      }
    }

    //  Only pick the attributes that are truthy or zero.

    const filteredAttributes = _.pickBy(attributes, isTruthyOrZero);

    //  If no attributes available, simply commit the changes to the database.

    if (_.isEmpty(filteredAttributes)) {
      await connection.commit();
      return true;
    }
    const joinedStringArray = _.map(filteredAttributes,
      (value, key) => (`${isTruthyOrZero(value) ? `${databaseName(key)} = :${key}` : ''}`));
    const joinedString = _(joinedStringArray).compact().join(', ');
    const patchSqlQuery = `
      UPDATE PLAYERS
      SET ${joinedString}
      WHERE PLAYER_ID = :id
      `;
    filteredAttributes.id = playerId;
    const response = await connection.execute(patchSqlQuery,
      filteredAttributes,
      { autoCommit: true });
    return response.rowsAffected > 0;
  } finally {
    connection.close();
  }
};

module.exports = {
  getPlayersByGameId,
  getPlayerByGameIdAndPlayerId,
  cleanPlayerCardsByPlayerId,
  deletePlayerByPlayerId,
  postPlayerByGameId,
  deletePlayersByMemberId,
  patchPlayer,
};
