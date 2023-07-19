import logging from '@tryghost/logging';
import tpl from '@tryghost/tpl';
import ObjectID from 'bson-objectid';
import {Collection} from './Collection';
import {CollectionRepository} from './CollectionRepository';
import {CollectionPost} from './CollectionPost';
import {MethodNotAllowedError, NotFoundError} from '@tryghost/errors';
import {PostDeletedEvent} from './events/PostDeletedEvent';
import {PostAddedEvent} from './events/PostAddedEvent';
import {PostEditedEvent} from './events/PostEditedEvent';
import {RepositoryUniqueChecker} from './RepositoryUniqueChecker';

const messages = {
    cannotDeleteBuiltInCollectionError: {
        message: 'Cannot delete builtin collection',
        context: 'The collection {id} is a builtin collection and cannot be deleted'
    },
    collectionNotFound: {
        message: 'Collection not found',
        context: 'Collection with id: {id} does not exist'
    }
};

interface SlugService {
    generate(desired: string, options: {transaction: any}): Promise<string>;
}

type CollectionsServiceDeps = {
    collectionsRepository: CollectionRepository;
    postsRepository: PostsRepository;
    slugService: SlugService;
    DomainEvents: {
        subscribe: (event: any, handler: (e: any) => void) => void;
    };
};

type CollectionPostDTO = {
    id: string;
    sort_order: number;
};

type CollectionPostListItemDTO = {
    id: string;
    url: string;
    slug: string;
    title: string;
    featured: boolean;
    featured_image?: string;
    created_at: Date;
    updated_at: Date;
    published_at: Date,
    tags?: string[];
}

type ManualCollection = {
    title: string;
    type: 'manual';
    slug?: string;
    description?: string;
    feature_image?: string;
    filter?: null;
    deletable?: boolean;
};

type AutomaticCollection = {
    title: string;
    type: 'automatic';
    filter: string;
    slug?: string;
    description?: string;
    feature_image?: string;
    deletable?: boolean;
};

type CollectionInputDTO = ManualCollection | AutomaticCollection;

type CollectionDTO = {
    id: string;
    title: string | null;
    slug: string;
    description: string | null;
    feature_image: string | null;
    type: 'manual' | 'automatic';
    filter: string | null;
    created_at: Date;
    updated_at: Date | null;
    posts: CollectionPostDTO[];
};

type QueryOptions = {
    filter?: string;
    include?: string;
    page?: number;
    limit?: number;
    transaction?: any;
}

interface PostsRepository {
    getAll(options: QueryOptions): Promise<any[]>;
    getBulk(ids: string[]): Promise<any[]>;
}

export class CollectionsService {
    private collectionsRepository: CollectionRepository;
    private postsRepository: PostsRepository;
    private DomainEvents: {
        subscribe: (event: any, handler: (e: any) => void) => void;
    };
    private uniqueChecker: RepositoryUniqueChecker;
    private slugService: SlugService;

    constructor(deps: CollectionsServiceDeps) {
        this.collectionsRepository = deps.collectionsRepository;
        this.postsRepository = deps.postsRepository;
        this.DomainEvents = deps.DomainEvents;
        this.uniqueChecker = new RepositoryUniqueChecker(this.collectionsRepository);
        this.slugService = deps.slugService;
    }

    private toDTO(collection: Collection): CollectionDTO {
        return {
            id: collection.id,
            title: collection.title,
            slug: collection.slug,
            description: collection.description || null,
            feature_image: collection.featureImage || null,
            type: collection.type,
            filter: collection.filter,
            created_at: collection.createdAt,
            updated_at: collection.updatedAt,
            posts: collection.posts.map((postId, index) => ({
                id: postId,
                sort_order: index
            }))
        };
    }

    private toCollectionPostDTO(post: any): CollectionPostListItemDTO {
        return {
            id: post.id,
            url: post.url,
            slug: post.slug,
            title: post.title,
            featured: post.featured,
            featured_image: post.featured_image,
            created_at: post.created_at,
            updated_at: post.updated_at,
            published_at: post.published_at,
            tags: post.tags
        };
    }

    private fromDTO(data: any): any {
        const mappedDTO: {[index: string]:any} = {
            title: data.title,
            slug: data.slug,
            description: data.description,
            featureImage: data.feature_image,
            filter: data.filter
        };

        // delete out keys that contain undefined values
        for (const key of Object.keys(mappedDTO)) {
            if (mappedDTO[key] === undefined) {
                delete mappedDTO[key];
            }
        }

        return mappedDTO;
    }

    /**
     * @description Subscribes to Domain events to update collections when posts are added, updated or deleted
     */
    subscribeToEvents() {
        this.DomainEvents.subscribe(PostDeletedEvent, async (event: PostDeletedEvent) => {
            logging.info(`PostDeletedEvent received, removing post ${event.id} from all collections`);
            await this.removePostFromAllCollections(event.id);
        });

        this.DomainEvents.subscribe(PostAddedEvent, async (event: PostAddedEvent) => {
            logging.info(`PostAddedEvent received, adding post ${event.data.id} to matching collections`);
            await this.addPostToMatchingCollections(event.data);
        });

        this.DomainEvents.subscribe(PostEditedEvent, async (event: PostEditedEvent) => {
            logging.info(`PostEditedEvent received, updating post ${event.data.id} in matching collections`);
            await this.updatePostInMatchingCollections(event.data);
        });
    }

    async createCollection(data: CollectionInputDTO): Promise<CollectionDTO> {
        return await this.collectionsRepository.createTransaction(async (transaction) => {
            const slug = await this.slugService.generate(data.slug || data.title, {
                transaction: transaction
            });
            const collection = await Collection.create({
                title: data.title,
                slug: slug,
                description: data.description,
                type: data.type,
                filter: data.filter,
                featureImage: data.feature_image,
                deletable: data.deletable
            });

            if (collection.type === 'automatic' && collection.filter) {
                const posts = await this.postsRepository.getAll({
                    filter: collection.filter,
                    transaction: transaction
                });

                for (const post of posts) {
                    collection.addPost(post);
                }
            }

            await this.collectionsRepository.save(collection, {
                transaction: transaction
            });

            return this.toDTO(collection);
        });
    }

    async addPostToCollection(collectionId: string, post: CollectionPostListItemDTO): Promise<CollectionDTO | null> {
        const collection = await this.collectionsRepository.getById(collectionId);

        if (!collection) {
            return null;
        }

        collection.addPost(post);

        await this.collectionsRepository.save(collection);

        return this.toDTO(collection);
    }

    private async updateAutomaticCollectionItems(collection: Collection, filter:string) {
        const posts = await this.postsRepository.getAll({
            filter: filter
        });

        collection.removeAllPosts();

        for (const post of posts) {
            await collection.addPost(post);
        }
    }

    private async removePostFromAllCollections(postId: string) {
        // @NOTE: can be optimized by having a "getByPostId" method on the collections repository
        const collections = await this.collectionsRepository.getAll();

        for (const collection of collections) {
            if (collection.includesPost(postId)) {
                await collection.removePost(postId);
            }
        }
    }

    private async addPostToMatchingCollections(post: CollectionPost) {
        return await this.collectionsRepository.createTransaction(async (transaction) => {
            const collections = await this.collectionsRepository.getAll({
                filter: 'type:automatic',
                transaction: transaction
            });

            for (const collection of collections) {
                const added = await collection.addPost(post);

                if (added) {
                    await this.collectionsRepository.save(collection, {
                        transaction: transaction
                    });
                }
            }
        });
    }

    async updatePostInMatchingCollections(postEdit: PostEditedEvent['data']) {
        const collections = await this.collectionsRepository.getAll({
            filter: 'type:automatic'
        });

        for (const collection of collections) {
            if (collection.includesPost(postEdit.id) && !collection.postMatchesFilter(postEdit.current)) {
                await collection.removePost(postEdit.id);
                await this.collectionsRepository.save(collection);

                logging.info(`[Collections] Post ${postEdit.id} was updated and removed from collection ${collection.id} with filter ${collection.filter}`);
            } else if (!collection.includesPost(postEdit.id) && collection.postMatchesFilter(postEdit.current)) {
                const added = await collection.addPost(postEdit.current);

                if (added) {
                    await this.collectionsRepository.save(collection);
                }

                logging.info(`[Collections] Post ${postEdit.id} was updated and added to collection ${collection.id} with filter ${collection.filter}`);
            } else {
                logging.info(`[Collections] Post ${postEdit.id} was updated but did not update any collections`);
            }
        }
    }

    async edit(data: any): Promise<CollectionDTO | null> {
        const collection = await this.collectionsRepository.getById(data.id);

        if (!collection) {
            return null;
        }

        const collectionData = this.fromDTO(data);
        await collection.edit(collectionData, this.uniqueChecker);

        if (collection.type === 'manual' && data.posts) {
            for (const post of data.posts) {
                collection.addPost(post);
            }
        }

        if (collection.type === 'automatic' && data.filter) {
            await this.updateAutomaticCollectionItems(collection, data.filter);
        }

        await this.collectionsRepository.save(collection);

        return this.toDTO(collection);
    }

    async getById(id: string): Promise<Collection | null> {
        return await this.collectionsRepository.getById(id);
    }

    async getBySlug(slug: string): Promise<Collection | null> {
        return await this.collectionsRepository.getBySlug(slug);
    }

    async getAll(options?: QueryOptions): Promise<{data: CollectionDTO[], meta: any}> {
        const collections = await this.collectionsRepository.getAll(options);

        const collectionsDTOs: CollectionDTO[] = [];

        for (const collection of collections) {
            collectionsDTOs.push(this.toDTO(collection));
        }

        return {
            data: collectionsDTOs,
            meta: {
                pagination: {
                    page: 1,
                    pages: 1,
                    limit: collections.length,
                    total: collections.length,
                    prev: null,
                    next: null
                }
            }
        };
    }

    /**
     * @param id {string | ObjectID} - collection id or slug
     * @param pagingOpts {QueryOptions}
     * @returns
     */
    async getAllPosts(id: string, {limit = 15, page = 1}: QueryOptions): Promise<{data: CollectionPostListItemDTO[], meta: any}> {
        let collection;

        if (ObjectID.isValid(id)) {
            collection = await this.getById(id);
        } else {
            collection = await this.getBySlug(id);
        }

        if (!collection) {
            throw new NotFoundError({
                message: tpl(messages.collectionNotFound.message),
                context: tpl(messages.collectionNotFound.context, {id})
            });
        }

        const startIdx = limit * (page - 1);
        const endIdx = limit * page;
        const postIds = collection.posts.slice(startIdx, endIdx);
        const posts = await this.postsRepository.getBulk(postIds);

        return {
            data: posts.map(this.toCollectionPostDTO),
            meta: {
                pagination: {
                    page: page,
                    pages: Math.ceil(collection.posts.length / limit),
                    limit: limit,
                    total: posts.length,
                    prev: null,
                    next: null
                }
            }
        };
    }

    async getCollectionsForPost(postId: string): Promise<CollectionDTO[]> {
        const collections = await this.collectionsRepository.getAll({
            filter: `posts:${postId}`
        });

        return collections.map(collection => this.toDTO(collection))
            .sort((a, b) => {
                // NOTE: sorting is here to keep DB engine ordering consistent
                return a.slug.localeCompare(b.slug);
            });
    }

    async destroy(id: string): Promise<Collection | null> {
        const collection = await this.getById(id);

        if (collection) {
            if (collection.deletable === false) {
                throw new MethodNotAllowedError({
                    message: tpl(messages.cannotDeleteBuiltInCollectionError.message),
                    context: tpl(messages.cannotDeleteBuiltInCollectionError.context, {
                        id: collection.id
                    })
                });
            }

            collection.deleted = true;
            await this.collectionsRepository.save(collection);
        }

        return collection;
    }

    async removePostFromCollection(id: string, postId: string): Promise<CollectionDTO | null> {
        const collection = await this.getById(id);

        if (!collection) {
            return null;
        }

        if (collection) {
            collection.removePost(postId);
            await this.collectionsRepository.save(collection);
        }

        return this.toDTO(collection);
    }
}
