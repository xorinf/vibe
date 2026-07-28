import { calculateNewOrder } from '#courses/utils/calculateNewOrder.js';

import { Expose, Transform, Type } from 'class-transformer';
import { ObjectId } from 'mongodb';

import {
  ObjectIdToString,
  StringToObjectId,
} from '#root/shared/constants/transformerConstants.js';
import {
  ID,
  ItemType,
  IQuizDetails,
  IVideoDetails,
  IBlogDetails,
  IFeedBackFormDetails,
  IIeDetails,
} from '#root/shared/interfaces/models.js';

export type Item = QuizItem | VideoItem | BlogItem | ProjectItem | IeItem;

class QuizItem {
  @Expose()
  @Transform(ObjectIdToString.transformer, { toPlainOnly: true })
  @Transform(StringToObjectId.transformer, { toClassOnly: true })
  _id?: ID;

  @Expose()
  name: string;

  @Expose()
  isOptional?: boolean = false;

  @Expose()
  description: string;

  @Expose()
  type: ItemType = ItemType.QUIZ;

  @Expose()
  details?: IQuizDetails;

  @Expose()
  isDeleted?: boolean;

  @Expose()
  deletedAt?: Date;

  @Expose()
  isHidden: boolean;

  constructor(
    name: string,
    description: string,
    details: IQuizDetails,
    _id: ID,
  ) {
    this._id = _id;
    this.type = ItemType.QUIZ;
    this.name = name;
    this.description = description;
    this.details = details;
    this.isDeleted = false;
    this.deletedAt = undefined;
  }
}

class VideoItem {
  @Expose()
  @Transform(ObjectIdToString.transformer, { toPlainOnly: true })
  @Transform(StringToObjectId.transformer, { toClassOnly: true })
  _id?: ID;

  @Expose()
  name: string;

  @Expose()
  isOptional?: boolean = false;

  @Expose()
  description: string;

  @Expose()
  type: ItemType = ItemType.VIDEO;

  @Expose()
  details?: IVideoDetails;

  @Expose()
  isHidden?: boolean;

  @Expose()
  isDeleted?: boolean;

  @Expose()
  deletedAt?: Date;

  constructor(
    name: string,
    description: string,
    details: IVideoDetails,
    _id: ID,
  ) {
    this._id = _id;
    this.type = ItemType.VIDEO;
    this.name = name;
    this.description = description;
    this.details = details;
    this.isDeleted = false;
    this.deletedAt = undefined;
  }
}

class BlogItem {
  @Expose()
  @Transform(ObjectIdToString.transformer, { toPlainOnly: true })
  @Transform(StringToObjectId.transformer, { toClassOnly: true })
  _id?: ID;

  @Expose()
  name: string;

  @Expose()
  isOptional?: boolean = false;

  @Expose()
  description: string;

  @Expose()
  type: ItemType = ItemType.BLOG;

  @Expose()
  details?: IBlogDetails;

  @Expose()
  isDeleted?: boolean;

  @Expose()
  deletedAt?: Date;

  @Expose()
  isHidden?: boolean;

  constructor(
    name: string,
    description: string,
    details: IBlogDetails,
    _id: ID,
  ) {
    this._id = _id;
    this.type = ItemType.BLOG;
    this.name = name;
    this.description = description;
    this.details = details;
    this.isDeleted = false;
    this.deletedAt = undefined;
  }
}

class FeedBackFormItem {
  @Expose()
  @Transform(ObjectIdToString.transformer, { toPlainOnly: true })
  @Transform(StringToObjectId.transformer, { toClassOnly: true })
  _id?: ID;

  @Expose()
  name: string;

  @Expose()
  description: string;

  @Expose()
  isOptional: boolean;

  @Expose()
  type: ItemType = ItemType.FEEDBACK;

  @Expose()
  details: IFeedBackFormDetails;

  constructor(
    name: string,
    description: string,
    _id: ID,
    details?: IFeedBackFormDetails,
    isOptional: boolean = false,
  ) {
    this._id = _id;
    this.type = ItemType.FEEDBACK;
    this.name = name;
    this.isOptional = isOptional;
    this.description = description;

    if (details) {
      this.details = details;
    }
  }
}

class FeedbackSubmissionItem {
  @Expose()
  @Transform(ObjectIdToString.transformer, { toPlainOnly: true })
  @Transform(StringToObjectId.transformer, { toClassOnly: true })
  _id?: ID;

  @Expose()
  userId: ID;

  @Expose()
  courseId: ID;

  @Expose()
  courseVersionId: ID;

  @Expose()
  previousItemId: ID;

  @Expose()
  previousItemType: ItemType;

  @Expose()
  feedbackFormId: ID;

  @Expose()
  details: Record<string, any>;

  // @Expose()
  // isSkipped: boolean;

  @Expose()
  createdAt: Date;

  @Expose()
  updatedAt: Date;

  @Expose()
  cohortId?: ID;

  constructor(
    userId: string,
    courseId: string,
    courseVersionId: string,
    previousItemId: string,
    previousItemType: ItemType,
    feedbackFormId: string,
    details: Record<string, any>,
    _id?: ID,
    cohortId?: ID,
  ) {
    this._id = _id;
    this.userId = userId;
    this.courseId = courseId;
    this.courseVersionId = courseVersionId;
    this.previousItemId = previousItemId;
    this.previousItemType = previousItemType;
    this.feedbackFormId = feedbackFormId;
    this.details = details;
    // this.isSkipped = isSkipped;
    this.createdAt = new Date();
    this.updatedAt = new Date();
    if(cohortId){
      this.cohortId = cohortId
    }
  }
}

class ProjectItem {
  @Expose()
  @Transform(ObjectIdToString.transformer, { toPlainOnly: true })
  @Transform(StringToObjectId.transformer, { toClassOnly: true })
  _id?: ID;

  @Expose()
  name: string;

  @Expose()
  isOptional?: boolean = false;

  @Expose()
  description: string;

  @Expose()
  type: ItemType = ItemType.PROJECT;

  details?: any;

  @Expose()
  isDeleted?: boolean;

  @Expose()
  deletedAt?: Date;

  @Expose()
  isHidden?: boolean;

  constructor(
    name: string,
    description: string,
    _id: ID,
    details?: any,
    isOptional: boolean = false,
  ) {
    this._id = _id;
    this.type = ItemType.PROJECT;
    this.name = name;
    this.description = description;
    this.isOptional = isOptional;

    if (details) {
      this.details = details;
    }
    this.isDeleted = false;
    this.deletedAt = undefined;
  }
}

/**
 * ItemsGroup row for an Interactive Learning Experience. Mirrors the
 * `ProjectItem` pattern — the rich ILE content lives in the
 * `interactive_experiences` collection, and this row only holds the
 * pointer + status mirror so the section's item list reflects the
 * latest saved state.
 */
class IeItem {
  @Expose()
  @Transform(ObjectIdToString.transformer, { toPlainOnly: true })
  @Transform(StringToObjectId.transformer, { toClassOnly: true })
  _id?: ID;

  @Expose()
  name: string;

  @Expose()
  isOptional?: boolean = false;

  @Expose()
  description: string;

  @Expose()
  type: ItemType = ItemType.INTERACTIVE_EXPERIENCE;

  @Expose()
  details?: IIeDetails;

  @Expose()
  isDeleted?: boolean;

  @Expose()
  deletedAt?: Date;

  @Expose()
  isHidden?: boolean;

  constructor(
    name: string,
    description: string,
    _id: ID,
    details?: IIeDetails,
  ) {
    this._id = _id;
    this.type = ItemType.INTERACTIVE_EXPERIENCE;
    this.name = name;
    this.description = description;
    if (details) {
      this.details = details;
    }
    this.isDeleted = false;
    this.deletedAt = undefined;
  }
}

class ItemBase {
  @Expose()
  @Transform(ObjectIdToString.transformer, { toPlainOnly: true })
  @Transform(StringToObjectId.transformer, { toClassOnly: true })
  itemId?: ID;

  @Expose()
  type: ItemType;

  @Expose()
  order: string;

  @Expose()
  itemDetails: Item;

  constructor(itemBody: any, existingItems: ItemRef[]) {
    this.itemId = new ObjectId();
    const quizDetails = itemBody.quizDetails as IQuizDetails;
    if (itemBody) {
      this.type = itemBody.type;
      switch (this.type) {
        case ItemType.VIDEO:
          this.itemDetails = new VideoItem(
            itemBody.name,
            itemBody.description,
            itemBody.videoDetails,
            this.itemId,
          );
          break;
        case ItemType.QUIZ:
          quizDetails.questionBankRefs = [];
          this.itemDetails = new QuizItem(
            itemBody.name,
            itemBody.description,
            quizDetails,
            this.itemId,
          );
          break;
        case ItemType.BLOG:
          this.itemDetails = new BlogItem(
            itemBody.name,
            itemBody.description,
            itemBody.blogDetails,
            this.itemId,
          );
          break;
        case ItemType.PROJECT:
          // For PROJECT, prefer details.name/description if present (for consistency with validation)
          let pname = itemBody.name;
          let pdesc = itemBody.description;
          if (
            itemBody.details &&
            (itemBody.details.name || itemBody.details.description)
          ) {
            pname = itemBody.details.name || pname;
            pdesc = itemBody.details.description || pdesc;
          }
          this.itemDetails = new ProjectItem(
            pname,
            pdesc,
            this.itemId,
            itemBody.details,
          );
          break;
        case ItemType.FEEDBACK:
          this.itemDetails = new FeedBackFormItem(
            itemBody.name,
            itemBody.description,
            this.itemId,
            itemBody.feedbackFormDetails,
          );
          break;
        case ItemType.INTERACTIVE_EXPERIENCE:
          // itemsGroup row is just a pointer at the rich ILE doc.
          // experienceId is empty on Add Item (the workspace creates
          // the ILE doc on first save and patches the pointer back).
          // Read `itemBody.ileDetails` (not `details`) — earlier
          // revisions read `details` and silently dropped the field.
          this.itemDetails = new IeItem(
            itemBody.name,
            itemBody.description,
            this.itemId,
            itemBody.ileDetails ?? {
              experienceId: '',
              status: 'draft',
              currentVersion: 0,
              updatedAt: Date.now(),
            },
          );
          break;
        default:
          break;
      }
    }

    if (existingItems) {
      const sortedItems = existingItems.sort((a, b) =>
        a.order.localeCompare(b.order),
      );
      this.order = calculateNewOrder(
        sortedItems,
        '_id',
        itemBody.afterItemId,
        itemBody.beforeItemId,
      );
    }
  }
}

class ItemRef {
  @Expose()
  @Transform(ObjectIdToString.transformer, { toPlainOnly: true })
  @Transform(StringToObjectId.transformer, { toClassOnly: true })
  _id?: ID;

  @Expose()
  type: ItemType;

  @Expose()
  order: string;

  @Expose()
  isHidden?: boolean;

  @Expose()
  name: string;

  /**
   * Per-type details (only populated for the row in question, not
   * the full itemsGroup document). Currently only ILE items carry
   * this in the section tree — the rich ILE content lives in the
   * `interactive_experiences` collection, so the itemsGroup row
   * only needs the `{ experienceId, status, currentVersion, updatedAt }`
   * pointer. Without exposing this, the inline view can't tell
   * whether an ILE item has been generated yet and falls back to
   * the empty "Not yet generated — click Edit" placeholder even
   * after the teacher has saved & published.
   *
   * Optional + typed loosely (any) because ProjectItem etc. have
   * their own detail shapes and we don't want to widen the
   * ItemRef contract until the other types need it.
   */
  @Expose()
  details?: any;

  constructor(item: ItemBase) {
    this._id = new ObjectId(item.itemId);
    this.type = item.type;
    this.order = item.order;
    this.name = item.itemDetails.name;
    if (item.itemDetails && (item.itemDetails as any).details !== undefined) {
      this.details = (item.itemDetails as any).details;
    }
  }
}

class ItemsGroup {
  @Expose()
  @Transform(ObjectIdToString.transformer, { toPlainOnly: true })
  @Transform(StringToObjectId.transformer, { toClassOnly: true })
  _id?: ID;

  @Expose()
  @Type(() => ItemRef)
  items: ItemRef[];

  @Expose()
  @Transform(ObjectIdToString.transformer, { toPlainOnly: true })
  @Transform(StringToObjectId.transformer, { toClassOnly: true })
  sectionId: ID;

  @Expose()
  isHidden?: boolean;

  constructor(sectionId?: ID, items?: ItemRef[]) {
    this.items = items ? items : [];
    this.sectionId = sectionId;
  }
}

// class AuditTrail {
//   @Expose()
//   @Transform(ObjectIdToString.transformer, { toPlainOnly: true })
//   @Transform(StringToObjectId.transformer, { toClassOnly: true })
//   _id?: ID;

//   @Expose()
//   itemId: ID;

//   @Expose()
//   action: string;

//   constructor(itemId: ID, action: string) {
//     this.itemId = itemId;
//     this.action = action;
//   }
// }

export {
  ItemBase,
  ItemsGroup,
  ItemRef,
  QuizItem,
  VideoItem,
  BlogItem,
  ProjectItem,
  IeItem,
  FeedBackFormItem,
  FeedbackSubmissionItem,
};
