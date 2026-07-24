-- A coupon applied on the cart page has to survive the navigation to checkout,
-- and the only trustworthy place to keep it is the cart row: holding it in a
-- cookie would let a customer edit the code client-side and holding it in memory
-- would lose it on the next request (Workers keep nothing between invocations).
ALTER TABLE carts ADD COLUMN coupon_code TEXT;
