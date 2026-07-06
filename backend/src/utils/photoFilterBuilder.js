/**
 * Photo Filter Query Builder
 * Builds Knex queries for filtering photos by feedback metrics
 */

class PhotoFilterBuilder {
  constructor(queryBuilder, eventId) {
    this.query = queryBuilder;
    this.eventId = eventId;
  }

  /**
   * Apply all filters from a filter object
   */
  applyFilters(filters = {}) {
    const {
      min_rating,
      max_rating,
      has_likes,
      min_likes,
      has_favorites,
      min_favorites,
      has_comments,
      category_id,
      logic = 'AND'
    } = filters;

    // Always filter by event
    this.query.where('photos.event_id', this.eventId);

    // Build conditions array
    const conditions = [];

    if (min_rating !== undefined && min_rating !== null) {
      conditions.push(builder => builder.where('photos.average_rating', '>=', min_rating));
    }

    if (max_rating !== undefined && max_rating !== null) {
      conditions.push(builder => builder.where('photos.average_rating', '<=', max_rating));
    }

    if (has_likes === true || has_likes === 'true') {
      conditions.push(builder => builder.where('photos.like_count', '>', 0));
    }

    if (min_likes !== undefined && min_likes !== null) {
      conditions.push(builder => builder.where('photos.like_count', '>=', min_likes));
    }

    if (has_favorites === true || has_favorites === 'true') {
      conditions.push(builder => builder.where('photos.favorite_count', '>', 0));
    }

    if (min_favorites !== undefined && min_favorites !== null) {
      conditions.push(builder => builder.where('photos.favorite_count', '>=', min_favorites));
    }

    if (has_comments === true || has_comments === 'true') {
      conditions.push(builder => builder.where('photos.comment_count', '>', 0));
    }

    if (category_id) {
      conditions.push(builder => builder.where('photos.category_id', category_id));
    }

    // Apply conditions with AND/OR logic
    if (conditions.length > 0) {
      if (logic === 'OR') {
        this.query.where(builder => {
          conditions.forEach((condition, index) => {
            if (index === 0) {
              condition(builder);
            } else {
              builder.orWhere(subBuilder => condition(subBuilder));
            }
          });
        });
      } else {
        // AND logic (default)
        conditions.forEach(condition => {
          this.query.where(builder => condition(builder));
        });
      }
    }

    return this;
  }

  /**
   * Apply sorting
   */
  applySorting(sort = 'date', order = 'desc') {
    const sortMap = {
      rating: 'photos.average_rating',
      likes: 'photos.like_count',
      favorites: 'photos.favorite_count',
      date: 'photos.created_at',
      filename: 'photos.filename'
    };

    const sortColumn = sortMap[sort] || sortMap.date;
    this.query.orderBy(sortColumn, order === 'asc' ? 'asc' : 'desc');

    return this;
  }

  /**
   * Apply pagination
   */
  applyPagination(page = 1, limit = 50) {
    const offset = (page - 1) * limit;
    this.query.limit(limit).offset(offset);
    return this;
  }

  /**
   * Get the built query
   */
  getQuery() {
    return this.query;
  }

  /**
   * Build a count query for the same filters
   */
  static buildCountQuery(db, eventId, filters = {}) {
    const builder = new PhotoFilterBuilder(
      db('photos').count('* as count'),
      eventId
    );
    builder.applyFilters(filters);
    return builder.getQuery();
  }

  /**
   * Build a summary query for feedback counts
   */
  static async getSummary(db, eventId) {
    const result = await db('photos')
      .where('event_id', eventId)
      .select(
        db.raw('COUNT(*) as total'),
        db.raw('COUNT(CASE WHEN average_rating > 0 THEN 1 END) as with_ratings'),
        db.raw('COUNT(CASE WHEN like_count > 0 THEN 1 END) as with_likes'),
        db.raw('COUNT(CASE WHEN favorite_count > 0 THEN 1 END) as with_favorites'),
        db.raw('COUNT(CASE WHEN comment_count > 0 THEN 1 END) as with_comments')
      )
      .first();

    return {
      total: parseInt(result.total) || 0,
      withRatings: parseInt(result.with_ratings) || 0,
      withLikes: parseInt(result.with_likes) || 0,
      withFavorites: parseInt(result.with_favorites) || 0,
      withComments: parseInt(result.with_comments) || 0
    };
  }
}

module.exports = { PhotoFilterBuilder };
