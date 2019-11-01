const models = require('../../../db/mysqldb/index')
const moment = require('moment')
const { resClientJson } = require('../../utils/resData')
const Op = require('sequelize').Op
const trimHtml = require('trim-html')
const xss = require('xss')
const clientWhere = require('../../utils/clientWhere')
const config = require('../../config')
const { TimeNow, TimeDistance } = require('../../utils/time')
const {
  statusList: { reviewSuccess, freeReview, pendingReview, reviewFail, deletes },
  articleType,
  userMessageType,
  userMessageAction
} = require('../../utils/constant')

function ErrorMessage (message) {
  this.message = message
  this.name = 'UserException'
}

/* 评论模块 */

class BookComment {
  static async getBookCommentList (ctx) {
    let book_id = ctx.query.book_id
    let page = ctx.query.page || 1
    let pageSize = ctx.query.pageSize || 10

    try {
      let { count, rows } = await models.book_comment.findAndCountAll({
        // 默认一级评论
        where: {
          book_id,
          parent_id: 0,
          status: {
            [Op.or]: [reviewSuccess, freeReview, pendingReview, reviewFail]
          }
        }, // 为空，获取全部，也可以自己添加条件
        offset: (page - 1) * pageSize, // 开始的数据索引，比如当page=2 时offset=10 ，而pagesize我们定义为10，则现在为索引为10，也就是从第11条开始返回数据条目
        limit: Number(pageSize), // 每页限制返回的数据条数
        order: [['create_date', 'desc']]
      })

      for (let i in rows) {
        rows[i].setDataValue(
          'create_dt',
          await TimeDistance(rows[i].create_date)
        )
        if (Number(rows[i].status) === pendingReview) {
          rows[i].setDataValue('content', '当前用户评论需要审核')
        }
        if (Number(rows[i].status) === reviewFail) {
          rows[i].setDataValue('content', '当前用户评论违规')
        }
        rows[i].setDataValue(
          'user',
          await models.user.findOne({
            where: { uid: rows[i].uid },
            attributes: ['uid', 'avatar', 'nickname', 'sex', 'introduction']
          })
        )
      }

      for (let item in rows) {
        // 循环取子评论
        let childAllComment = await models.book_comment.findAll({
          where: {
            parent_id: rows[item].id,
            status: {
              [Op.or]: [reviewSuccess, freeReview, pendingReview, reviewFail]
            }
          }
        })
        rows[item].setDataValue('children', childAllComment)
        for (let childCommentItem in childAllComment) {
          // 循环取用户  代码有待优化，层次过于复杂
          childAllComment[childCommentItem].setDataValue(
            'create_dt',
            await TimeDistance(childAllComment[childCommentItem].create_date)
          )
          childAllComment[childCommentItem].setDataValue(
            'user',
            await models.user.findOne({
              where: { uid: childAllComment[childCommentItem].uid },
              attributes: ['uid', 'avatar', 'nickname', 'sex', 'introduction']
            })
          )
          if (
            childAllComment[childCommentItem].reply_uid !== 0 &&
            childAllComment[childCommentItem].reply_uid !==
              childAllComment[childCommentItem].uid
          ) {
            childAllComment[childCommentItem].setDataValue(
              'reply_user',
              await models.user.findOne({
                where: { uid: childAllComment[childCommentItem].reply_uid },
                attributes: ['uid', 'avatar', 'nickname', 'sex', 'introduction']
              })
            )
          }
        }
      }

      await resClientJson(ctx, {
        state: 'success',
        message: '获取评论列表成功',
        data: {
          page,
          pageSize,
          count,
          comment_list: rows
        }
      })
    } catch (err) {
      resClientJson(ctx, {
        state: 'error',
        message: '错误信息：' + err.message
      })
      return false
    }
  }

  /**
   * 新建评论post提交
   * @param   {object} ctx 上下文对象
   */
  static async createBookComment (ctx) {
    let reqData = ctx.request.body
    let { user = '' } = ctx.request

    try {
      if (!reqData.content) {
        throw new ErrorMessage('请输入评论内容')
      }

      let date = new Date()
      let currDate = moment(date.setHours(date.getHours())).format(
        'YYYY-MM-DD HH:mm:ss'
      )

      if (new Date(currDate).getTime() < new Date(user.ban_dt).getTime()) {
        throw new ErrorMessage(
          `当前用户因违规已被管理员禁用发布评论，时间到：${moment(
            user.ban_dt
          ).format('YYYY年MM月DD日 HH时mm分ss秒')},如有疑问请联系网站管理员`
        )
      }

      let allUserRole = await models.user_role.findAll({
        where: {
          user_role_id: {
            [Op.or]: user.user_role_ids.split(',')
          },
          user_role_type: 1 // 用户角色类型1是默认角色
        }
      })
      let userAuthorityIds = ''
      allUserRole.map(roleItem => {
        userAuthorityIds += roleItem.user_authority_ids + ','
      })
      let status = ~userAuthorityIds.indexOf(
        config.BOOK.dfNoReviewBookCommentId
      )
        ? freeReview // 免审核
        : pendingReview // 待审核

      await models.book_comment
        .create({
          parent_id: reqData.parent_id || 0,
          books_id: reqData.books_id,
          book_id: reqData.book_id,
          star: reqData.star,
          uid: user.uid,
          reply_uid: reqData.reply_uid || 0,
          content: xss(reqData.content),
          status
        })
        .then(async data => {
          const oneUser = await models.user.findOne({
            where: { uid: user.uid }
          }) // 查询当前评论用户的信息

          let _data = {
            // 组合返回的信息
            ...data.get({
              plain: true
            }),
            children: [],
            user: oneUser
          }

          if (
            reqData.reply_uid &&
            reqData.reply_uid !== 0 &&
            reqData.reply_uid !== user.uid
          ) {
            _data.reply_user = await models.user.findOne({
              where: { uid: reqData.reply_uid },
              attributes: ['uid', 'avatar', 'nickname', 'sex', 'introduction']
            })
          }

          _data['create_dt'] = await TimeDistance(_data.create_date)

          resClientJson(ctx, {
            state: 'success',
            data: _data,
            message:
              Number(status) === freeReview
                ? '评论成功'
                : '评论成功,待审核后可见'
          })
        })
        .catch(err => {
          resClientJson(ctx, {
            state: 'error',
            message: '回复失败:' + err
          })
        })
    } catch (err) {
      resClientJson(ctx, {
        state: 'error',
        message: '错误信息：' + err.message
      })
      return false
    }
  }

  /**
   * 删除评论post提交
   * @param   {object} ctx 上下文对象
   */
  static async deleteBookComment (ctx) {
    let reqData = ctx.request.body
    let { user = '' } = ctx.request

    try {
      let allComment = await models.book_comment
        .findAll({ where: { parent_id: reqData.comment_id } })
        .then(res => {
          return res.map((item, key) => {
            return item.id
          })
        })

      if (allComment.length > 0) {
        // 判断当前评论下是否有子评论,有则删除子评论
        await models.book_comment.destroy({
          where: {
            id: { [Op.in]: allComment },
            uid: user.uid
          }
        })
      }

      await models.book_comment.destroy({
        where: {
          id: reqData.comment_id,
          uid: user.uid
        }
      })

      resClientJson(ctx, {
        state: 'success',
        message: '删除成功'
      })
    } catch (err) {
      resClientJson(ctx, {
        state: 'error',
        message: '错误信息：' + err.message
      })
      return false
    }
  }
}

module.exports = BookComment
