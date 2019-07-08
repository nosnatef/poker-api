const appRoot = require('app-root-path');
const _ = require('lodash');

const { serializeGames, serializeGame } = require('../../serializers/games-serializer');

const conn = appRoot.require('api/v1/db/oracledb/connection');
const mergeRawGames = (rawGames) => {
  const groupedRawGames = _.groupBy(rawGames, 'GAME_ID');
  const mergedRawGames = _.map(groupedRawGames, (gameMetaDataArray) => {
    if (gameMetaDataArray[0].CARD_NUMBER == null) {
      gameMetaDataArray[0].tableCards = [];
    } else {
      gameMetaDataArray[0].tableCards = _.map(gameMetaDataArray, data => ({
        cardNumber: data.CARD_NUMBER,
        cardSuit: data.SUIT,
      }));
    }
    return (gameMetaDataArray[0]);
  });
  return mergedRawGames;
};

const sqlQuery = `
    SELECT CN.CARD_NUMBER, CS.SUIT, G.GAME_ID, R.ROUND, G.MAXIMUM_BET,
    G.MINIMUM_BET, G.BET_POOL
    FROM GAMES G
    INNER JOIN ROUNDS R ON G.ROUND_ID = R.ROUND_ID
    LEFT OUTER JOIN TABLE_CARDS TC ON TC.GAME_ID = G.GAME_ID
    LEFT OUTER JOIN CARDS C ON TC.CARD_ID = C.CARD_ID
    LEFT OUTER JOIN CARD_NUMBERS CN ON C.CARD_NUMBER_ID = CN.CARD_NUMBER_ID
    LEFT OUTER JOIN CARD_SUITS CS ON C.CARD_SUIT_ID = CS.SUIT_ID
    `;
/**
 * @summary Return a list of games
 * @function
 * @returns {Promise<Object[]>} Promise object represents a list of games
 */
const getGames = async (query) => {
  const connection = await conn.getConnection();
  const round = query ? query.round : null;

  try {
    const sqlParams = {};
    if (round) {
      sqlParams.round = round;
    }
    const getGamesSqlQuery = `${sqlQuery} ${round ? 'WHERE R.ROUND = :round' : ''}`;
    const rawGamesResponse = await connection.execute(getGamesSqlQuery, sqlParams);
    let rawGames = rawGamesResponse.rows;
    rawGames = mergeRawGames(rawGames);
    const serializedGames = serializeGames(rawGames, query);
    return serializedGames;
  } finally {
    connection.close();
  }
};

const getGamesByMemberId = async (id) => {
  const connection = await conn.getConnection();
  try {
    const sqlParams = [id];
    const sqlQuery = `
    SELECT CARD_NUMBERS.CARD_NUMBER, CARD_SUITS.SUIT, GAMES.GAME_ID, ROUNDS.ROUND, GAMES.MAXIMUM_BET, 
    GAMES.MINIMUM_BET, GAMES.BET_POOL 
    FROM TABLE_CARDS, GAMES, CARDS, CARD_SUITS, CARD_NUMBERS, ROUNDS, PLAYERS
    WHERE GAMES.GAME_ID = TABLE_CARDS.GAME_ID AND 
    TABLE_CARDS.GAME_ID = GAMES.GAME_ID AND 
    TABLE_CARDS.CARD_ID = CARDS.CARD_ID AND
    CARDS.CARD_NUMBER_ID = CARD_NUMBERS.CARD_NUMBER_ID AND 
    CARDS.CARD_SUIT_ID = CARD_SUITS.SUIT_ID AND 
    GAMES.ROUND_ID = ROUNDS.ROUND_ID AND 
    PLAYERS.MEMBER_ID = :id AND 
    PLAYERS.GAME_ID = GAMES.GAME_ID
    `;
    const rawGamesResponse = await connection.execute(sqlQuery, sqlParams);
    let rawGames = rawGamesResponse.rows;
    rawGames = mergeRawGames(rawGames);
    console.log(rawGames);
    const serializedGames = serializeGames(rawGames);
    return serializedGames;
  } finally {
    connection.close();
  }
};

const getGameById = async (id) => {
  const connection = await conn.getConnection();
  try {
    const sqlParams = [id];
    const getGameByIdSqlQuery = `${sqlQuery} ${id ? 'WHERE G.GAME_ID = :id' : ''}`;
    const rawGamesResponse = await connection.execute(getGameByIdSqlQuery, sqlParams);
    const rawGames = rawGamesResponse.rows;
    let firstRawGame = [rawGames];
    firstRawGame = mergeRawGames(rawGames);
    if (_.isEmpty(firstRawGame)) {
      return undefined;
    }
    if (firstRawGame.length > 1) {
      throw new Error('Expect a single object but got multiple results.');
    } else {
      const serializedGame = serializeGame(firstRawGame);
      return serializedGame;
    }
  } finally {
    connection.close();
  }
};

module.exports = { getGames, getGameById, getGamesByMemberId };
