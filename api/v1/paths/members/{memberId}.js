const appRoot = require('app-root-path');

const membersDao = require('../../db/oracledb/member-dao');

const { errorBuilder, errorHandler } = appRoot.require('errors/errors');
const { openapi: { paths } } = appRoot.require('utils/load-openapi');

/**
 * @summary Get member by unique ID
 */
const get = async (req, res) => {
  try {
    const { memberId } = req.params;
    const result = await membersDao.getMemberById(memberId);
    if (!result) {
      errorBuilder(res, 404, 'A member with the specified ID was not found.');
    } else {
      res.send(result);
    }
  } catch (err) {
    errorHandler(res, err);
  }
};

get.apiDoc = paths['/members/{memberId}'].get;

module.exports = { get };