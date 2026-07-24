/**
 * Row shapes mirroring migrations/0001_init.sql exactly — column names, not
 * camelCase. Repositories return these; services map them to domain objects
 * where a nicer shape is worth the translation.
 */

export type UserRole = 'customer' | 'staff' | 'admin';
export type UserStatus = 'active' | 'disabled';

export interface UserRow {
  id: string;
  email: string;
  email_verified_at: number | null;
  password_hash: string | null;
  name: string;
  phone: string | null;
  role: UserRole;
  status: UserStatus;
  marketing_opt_in: number;
  failed_logins: number;
  locked_until: number | null;
  last_login_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface SessionRow {
  id: string;
  user_id: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  revoked_at: number | null;
  ip: string | null;
  user_agent: string | null;
}

export type TokenPurpose = 'email_verify' | 'password_reset' | 'order_access';

export interface AuthTokenRow {
  id: string;
  token_hash: string;
  user_id: string | null;
  purpose: TokenPurpose;
  email: string | null;
  order_id: string | null;
  expires_at: number;
  consumed_at: number | null;
  created_at: number;
}

export interface AddressRow {
  id: string;
  user_id: string;
  label: string;
  full_name: string;
  phone: string;
  line1: string;
  line2: string | null;
  landmark: string | null;
  city: string;
  state: string;
  pincode: string;
  country: string;
  is_default_shipping: number;
  is_default_billing: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

/** The address shape snapshotted onto an order and sent to the courier. */
export interface AddressSnapshot {
  full_name: string;
  phone: string;
  email?: string;
  line1: string;
  line2?: string | null;
  landmark?: string | null;
  city: string;
  state: string;
  pincode: string;
  country: string;
}

export type ProductStatus = 'draft' | 'active' | 'archived';

export interface ProductRow {
  id: string;
  slug: string;
  name: string;
  subtitle: string;
  description: string;
  category: string;
  status: ProductStatus;
  hero_image: string | null;
  images_json: string;
  ingredients: string;
  allergens: string;
  shelf_life_months: number | null;
  storage_note: string;
  is_veg: number;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export interface VariantRow {
  id: string;
  product_id: string;
  sku: string;
  name: string;
  weight_grams: number;
  shipping_weight_grams: number;
  price_paise: number;
  compare_at_price_paise: number | null;
  hsn_code: string;
  gst_rate_bps: number;
  status: 'active' | 'archived';
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export interface InventoryRow {
  variant_id: string;
  on_hand: number;
  reserved: number;
  reorder_level: number;
  track: number;
  updated_at: number;
}

export interface CartRow {
  id: string;
  user_id: string | null;
  status: 'active' | 'converted' | 'abandoned';
  currency: string;
  order_id: string | null;
  /** Added by migration 0003 — a coupon must survive cart → checkout. */
  coupon_code: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

export interface CartItemRow {
  id: string;
  cart_id: string;
  variant_id: string;
  qty: number;
  unit_price_paise: number;
  created_at: number;
  updated_at: number;
}

export type CouponType = 'percent' | 'fixed' | 'free_shipping';

export interface CouponRow {
  id: string;
  code: string;
  description: string;
  type: CouponType;
  value: number;
  min_subtotal_paise: number;
  max_discount_paise: number | null;
  starts_at: number | null;
  ends_at: number | null;
  usage_limit: number | null;
  per_user_limit: number;
  used_count: number;
  first_order_only: number;
  status: 'active' | 'disabled';
  provider_discount_id: string | null;
  created_at: number;
  updated_at: number;
}

export type OrderStatus =
  | 'pending_payment'
  | 'payment_failed'
  | 'confirmed'
  | 'processing'
  | 'packed'
  | 'shipped'
  | 'out_for_delivery'
  | 'delivered'
  | 'cancelled'
  | 'returned'
  | 'refunded';

export type PaymentStatus = 'pending' | 'authorized' | 'paid' | 'failed' | 'refunded' | 'partially_refunded';
export type FulfillmentStatus = 'unfulfilled' | 'processing' | 'fulfilled' | 'returned';
export type PaymentMethod = 'prepaid' | 'cod';

export interface OrderRow {
  id: string;
  order_number: string;
  user_id: string | null;
  email: string;
  phone: string;
  customer_name: string;
  is_guest: number;
  status: OrderStatus;
  payment_status: PaymentStatus;
  fulfillment_status: FulfillmentStatus;
  currency: string;
  subtotal_paise: number;
  discount_paise: number;
  shipping_paise: number;
  cod_fee_paise: number;
  tax_paise: number;
  total_paise: number;
  refunded_paise: number;
  tax_inclusive: number;
  coupon_id: string | null;
  coupon_code: string | null;
  payment_method: PaymentMethod;
  shipping_method: string;
  shipping_zone: string | null;
  total_weight_grams: number;
  shipping_address_json: string;
  billing_address_json: string;
  customer_note: string | null;
  admin_note: string | null;
  cancel_reason: string | null;
  guest_token_hash: string | null;
  idempotency_key: string | null;
  cart_id: string | null;
  placed_at: number;
  paid_at: number | null;
  shipped_at: number | null;
  delivered_at: number | null;
  cancelled_at: number | null;
  reserved_until: number | null;
  created_at: number;
  updated_at: number;
}

export interface OrderItemRow {
  id: string;
  order_id: string;
  variant_id: string;
  product_id: string;
  sku: string;
  product_name: string;
  variant_name: string;
  image: string | null;
  unit_price_paise: number;
  qty: number;
  subtotal_paise: number;
  discount_paise: number;
  tax_paise: number;
  tax_rate_bps: number;
  hsn_code: string | null;
  weight_grams: number;
  total_paise: number;
  created_at: number;
}

export interface OrderEventRow {
  id: string;
  order_id: string;
  type: string;
  message: string;
  data_json: string;
  actor_type: 'system' | 'customer' | 'admin' | 'provider';
  actor_id: string | null;
  is_customer_visible: number;
  created_at: number;
}

export interface PaymentRow {
  id: string;
  order_id: string;
  provider: string;
  provider_checkout_id: string | null;
  provider_payment_id: string | null;
  provider_customer_id: string | null;
  status: 'pending' | 'authorized' | 'paid' | 'failed' | 'cancelled' | 'refunded' | 'partially_refunded';
  amount_paise: number;
  currency: string;
  method: string | null;
  checkout_url: string | null;
  failure_reason: string | null;
  raw_json: string;
  created_at: number;
  updated_at: number;
  captured_at: number | null;
}

export interface RefundRow {
  id: string;
  order_id: string;
  payment_id: string | null;
  provider: string;
  provider_refund_id: string | null;
  amount_paise: number;
  status: 'pending' | 'completed' | 'failed';
  reason: string | null;
  actor_id: string | null;
  created_at: number;
  updated_at: number;
}

export type ShipmentStatus =
  | 'created'
  | 'pickup_scheduled'
  | 'picked_up'
  | 'in_transit'
  | 'out_for_delivery'
  | 'delivered'
  | 'failed_delivery'
  | 'rto_initiated'
  | 'rto_delivered'
  | 'cancelled';

export interface ShipmentRow {
  id: string;
  order_id: string;
  provider: string;
  provider_order_id: string | null;
  provider_shipment_id: string | null;
  awb_code: string | null;
  courier_name: string | null;
  status: ShipmentStatus;
  label_url: string | null;
  manifest_url: string | null;
  tracking_url: string | null;
  weight_grams: number;
  dimensions_json: string;
  charges_paise: number;
  pickup_scheduled_at: number | null;
  shipped_at: number | null;
  estimated_delivery_at: number | null;
  delivered_at: number | null;
  raw_json: string;
  created_at: number;
  updated_at: number;
}

export interface ShipmentEventRow {
  id: string;
  shipment_id: string;
  order_id: string;
  status: string;
  description: string;
  location: string | null;
  occurred_at: number;
  provider_event_id: string | null;
  raw_json: string;
  created_at: number;
}

export interface PincodeCacheRow {
  pincode: string;
  serviceable: number;
  cod_available: number;
  zone: string | null;
  city: string | null;
  state: string | null;
  etd_days: number | null;
  provider: string | null;
  raw_json: string;
  refreshed_at: number;
}

export interface NotificationRow {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  data_json: string;
  read_at: number | null;
  created_at: number;
}

export type OutboxStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'suppressed' | 'cancelled';

export interface EmailOutboxRow {
  id: string;
  to_email: string;
  to_name: string;
  from_email: string;
  from_name: string;
  reply_to: string | null;
  subject: string;
  template: string;
  text_body: string;
  html_body: string;
  data_json: string;
  status: OutboxStatus;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  provider: string | null;
  provider_message_id: string | null;
  user_id: string | null;
  order_id: string | null;
  idempotency_key: string | null;
  scheduled_at: number;
  sent_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface WebhookEventRow {
  id: string;
  source: 'payment' | 'shipping';
  provider: string;
  event_id: string;
  event_type: string;
  status: 'received' | 'processed' | 'failed' | 'ignored';
  signature_valid: number;
  payload_json: string;
  error: string | null;
  attempts: number;
  order_id: string | null;
  received_at: number;
  processed_at: number | null;
}

export interface SettingRow {
  key: string;
  value_json: string;
  updated_at: number;
  updated_by: string | null;
}

export interface ReviewRow {
  id: string;
  product_id: string;
  order_id: string | null;
  user_id: string | null;
  author_name: string;
  rating: number;
  title: string;
  body: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at: number;
  updated_at: number;
}
