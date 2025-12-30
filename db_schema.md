create table public.sa_communities (
  id uuid not null,
  contract_address text null,
  name text null,
  kind text null,
  photo_url text null,
  constraint sa_communities_pkey primary key (id)
) TABLESPACE pg_default;


create table public.sa_embeddings (
  thread_id uuid not null,
  image_id bigint null,
  embedding public.vector not null,
  id bigserial not null,
  constraint sa_embeddings_pkey primary key (id),
  constraint sa_embeddings_image_id_fkey foreign KEY (image_id) references sa_images (id) on delete CASCADE,
  constraint sa_embeddings_thread_id_fkey foreign KEY (thread_id) references sa_threads (id) on delete CASCADE
) TABLESPACE pg_default;

create index IF not exists sa_embeddings_ivff on public.sa_embeddings using ivfflat (embedding vector_cosine_ops)
with
  (lists = '100') TABLESPACE pg_default;

create unique INDEX IF not exists sa_embeddings_thread_unique on public.sa_embeddings using btree (thread_id) TABLESPACE pg_default
where
  (image_id is null);

create unique INDEX IF not exists sa_embeddings_image_unique on public.sa_embeddings using btree (image_id) TABLESPACE pg_default
where
  (image_id is not null);


create table public.sa_image_analysis (
  image_id bigint not null,
  ocr_text text null,
  caption text null,
  topics text[] null,
  entities jsonb null,
  safety_flags text[] null,
  sentiment text null,
  meme_template text null,
  meta jsonb null,
  constraint sa_image_analysis_pkey primary key (image_id),
  constraint sa_image_analysis_image_id_fkey foreign KEY (image_id) references sa_images (id) on delete CASCADE
) TABLESPACE pg_default;


create table public.sa_images (
  id bigint not null,
  thread_id uuid null,
  source_url text not null,
  storage_path text null,
  mime text null,
  is_gif boolean null default false,
  width integer null,
  height integer null,
  sha256 text null,
  constraint sa_images_pkey primary key (id),
  constraint sa_images_thread_id_fkey foreign KEY (thread_id) references sa_threads (id) on delete CASCADE
) TABLESPACE pg_default;

create index IF not exists sa_images_thread_id_idx on public.sa_images using btree (thread_id) TABLESPACE pg_default;


create table public.sa_threads (
  id uuid not null,
  user_id uuid null,
  community_id uuid null,
  content_html text null,
  content_text text null,
  thread_type text null,
  language text null,
  display_status integer null,
  created_at timestamp with time zone null,
  updated_at timestamp with time zone null,
  answer_count integer null default 0,
  like_count integer null default 0,
  bookmark_count integer null default 0,
  repost_count integer null default 0,
  is_edited boolean null default false,
  is_deleted boolean null default false,
  is_pinned boolean null default false,
  pinned_in_community boolean null default false,
  paywall boolean null default false,
  price numeric null,
  currency text null,
  currency_address text null,
  currency_decimals integer null,
  tip_amount numeric null,
  tip_count integer null,
  constraint sa_threads_pkey primary key (id),
  constraint sa_threads_community_id_fkey foreign KEY (community_id) references sa_communities (id) on delete set null,
  constraint sa_threads_user_id_fkey foreign KEY (user_id) references sa_users (id) on delete CASCADE
) TABLESPACE pg_default;

create index IF not exists sa_threads_created_at_idx on public.sa_threads using btree (created_at desc) TABLESPACE pg_default;

create index IF not exists sa_threads_community_id_idx on public.sa_threads using btree (community_id) TABLESPACE pg_default;

create index IF not exists sa_threads_user_id_idx on public.sa_threads using btree (user_id) TABLESPACE pg_default;


create table public.sa_users (
  id uuid not null,
  handle text null,
  name text null,
  picture text null,
  address text null,
  constraint sa_users_pkey primary key (id)
) TABLESPACE pg_default;


this is my db schema right now