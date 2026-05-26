# FamilyMeal — Project Orca Detailed Scope Document

> Source: "Family Meal :: Project Orca Detailed Scope Document" (Google Doc / PDF, 21 pages)
> **IMPORTANT:** Consult this document before building any restaurant portal feature to ensure parity with FM.

---

## 1. Overview

Project Orca extends FamilyMeal's core functionality by introducing:
- Scalable administrative roles (Regional Admin)
- Centralised menu management (Global Menus)
- Streamlined Stripe onboarding for multi-entity businesses
- Improved reporting and analytics
- Flexible order editing
- Subscription management

Goal: allow a 500-location restaurant chain to onboard, operate, and manage daily business without manual bottlenecks.

---

## 2. General Requirements

- **System Reliability**: Eliminate all payment, page-loading, and menu availability bugs.
- **Data Accuracy**: All displayed data must be synchronised, up-to-date, and reliable across all modules.
- **Performance**: Optimize backend and database interactions for scalability across hundreds of restaurant instances.

---

## 3. Scope of Work

### 3.1 Restaurant Regional Admin Role — **High Priority**

#### Overview
A new role called **Restaurant Regional Admin** bridges the gap between System Admins and Restaurant Admins, providing regional oversight over a defined group of locations.

#### Access and Role Creation
- Created and assigned by a System Admin via Authorized Users Management in the System Admin Portal.
- System Admin specifies: name, email, and multi-select list of assigned restaurant locations.
- Regional Admin receives invitation email with secure registration link.

#### Permissions
- **Dashboard Access**: Cumulative metrics across assigned restaurants (total sales, order count, top performers).
- **Reports and Analytics**: Generate, view, and export reports for assigned restaurants.
- **Authorized Users Management**: Create/manage Regional Admins (within their region) and Restaurant Admins/Users. Cannot create/modify System Admin accounts.
- **Order and Customer Management**: Full visibility into orders, customers, and transactions for assigned restaurants.
- **Locations Management**: Add, edit, or delete locations. Full access to restaurant profiles and online ordering toggles.
- **Menu Management**: View, activate, deactivate menus; access and manage Global Menus (see 3.2).

#### Available Portal Tabs
Dashboard Analytics, Reports, Orders, Authorized Users, Locations, Links (Restaurant URLs), Menus (including Global Menus)

All tabs aggregate data only for the restaurants the Regional Admin manages.

#### Restrictions
- Cannot create/edit/delete System Admin accounts.
- Cannot modify platform-wide settings, APIs, or financial integrations.
- Cannot access restaurants or users outside assigned region.
- System Admin retains override privileges.

#### Audit and Security
All Regional Admin actions logged in system activity log with user ID and timestamp.

---

### 3.2 Global Menu Management — **Low Priority**

#### Overview
Centralized system for creating and controlling menus across multiple restaurant locations. System Admins and Regional Admins define Global Menus deployable instantly across hundreds of locations.

#### Permissions
- System Admins and Regional Admins: create and manage Global Menus.
- Restaurant Admins: view, activate/deactivate. Can duplicate to create local editable version. Cannot edit directly.

#### Key Features
1. **Global Menu Creation** (via "Global Menus" tab in Menu Management):
   - Menu Name, Categories, Menu Items, Add-ons & Modifiers
   - Availability Schedule (Always Available / Custom)
   - Pricing and Tax Settings, Prep Time, Order Cut-off Rules

2. **Menu Activation**:
   - Once activated, all locations can access the Global Menu.
   - Restaurant Admins can duplicate (creates "Copy" marked local version) or use as-is.
   - Changes to a Global Menu reflect immediately across all linked restaurants.
   - Can be toggled Active/Inactive at both global and location level.
   - Warning popup before delete/deactivate.
   - Disabled global items cascade as hidden to all connected restaurants.

3. **Version Control**:
   - Version tracking for rollback and audit.
   - Version history with timestamp and user; option to revert.

#### Audit and Logging
Every action (creation, update, activation, deactivation, duplication) logged with: action type, performed by, affected restaurants, timestamp.

---

### 3.3 Stripe Onboarding Improvements — **Medium Priority**

#### Problem
- Current process breaks after 5–6 linked Stripe accounts (repeated KYC).
- Shared parent company / identical banking details require redundant data entry.
- FM is not set up to receive volume rebates from Stripe.

#### Proposed Solution
1. **Stripe Networked Onboarding**: Reuse verified business and banking info across multiple accounts. Once parent company is verified, details copy to new connected accounts.
2. **Multi-Entity Business Architecture**: Single platform account + multiple connected Standard accounts per restaurant + shared API key.
3. **Streamlined Data Synchronization**: Changes to parent-level info propagate to all related accounts automatically.
4. **Migration**: New onboarding integrates into existing Restaurant Admin Profile Management / Stripe Connect section. Backend migration script re-links existing accounts.

#### Alternative
If Stripe remains restrictive, explore **Finix Payments**: equivalent connected-account management, additional revenue through credit card processing fees.

#### User Flow
1. System Admin adds new restaurant location in Locations Management.
2. Restaurant admin receives prompt to connect to Stripe via Networked Onboarding.
3. If part of verified parent business, details auto-populate.
4. Restaurant completes verification (if needed) and confirms linked account.
5. Payments route through correct connected account.

---

### 3.4 Updated Reporting and Analytics — **High Priority**

#### Overview
Expands reporting to deliver accurate, customizable, automated insights across all user levels.

#### Role Access
| Role | Capabilities |
|------|-------------|
| FM Admin | Full platform — all restaurants and users |
| System Admin | Chain-level — all restaurants under their system |
| Regional Admin | Region-level — assigned restaurants only |
| Restaurant Admin | Location-level — individual restaurant |

#### Core Features
1. **Enhanced Data Accuracy**: Syncs with Orders, Payments, Customers DBs. Standardized currency formatting. Nightly cross-check validation against Stripe/Finix data.

2. **Custom Reports** (available to Restaurant, System, Regional Admins):
   - Financial Metrics: Gross Sales, Net Sales, Tax, Tips, Service Charges, Refunds, Stripe Fees, Total Revenue
   - Customer Metrics: Name, Email, Lifetime Order Value, Repeat Orders
   - Restaurant Metrics: Name, Location, Total Orders, Average Order Value
   - Filters: Date Range, Location (single/multi), Order Status, Fulfillment Type, Date Filter (Order Date vs. Created Date)

3. **Report Scheduling and Automation**:
   - Save and schedule recurring reports (Weekly / Monthly).
   - Selectable delivery time and timezone; one or more email recipients.
   - Delivered as PDF and CSV.
   - Confirmation log of deliveries with delivery status indicators.

4. **Report Export Options**: PDF, Excel (XLSX), CSV. Download immediately or email from within dashboard.

5. **Analytics Dashboard Enhancements**: Interactive charts — Sales by Location (bar), Order Volume by Day/Week (line), Top-Selling Items (pie), Customer Retention Trend (area). Hover tooltips. Real-time updates.

6. **Email and Notification Integration**: Alerts for new reports, failed deliveries, scheduled exports. Opt in/out in Profile Settings.

---

### 3.5 Order Editing (Restaurant + Customer)

- **Restaurant-initiated edits**: High Priority
- **Customer-initiated edits**: Very Low Priority

#### Overview
Allows customers and restaurants to modify orders after placement within controlled limits.

#### Role Access
| Role | Capabilities |
|------|-------------|
| Customer | Edit pickup/delivery time, modify items, cancel within allowed window |
| Restaurant Admin / System Admin / Regional Admin | Approve/reject edits, modify order details, process partial/full refunds |
| System Admin / Regional Admin | Monitor edited orders, view activity logs |

#### Features

1. **Configurable Edit Window**: Set "Edit Time Limit" in Restaurant Settings > Order Management Parameters (e.g., 30 min before order time or until prep begins).

2. **Customer Order Editing (Very Low Priority)**:
   - Modify Pickup/Delivery Time (subject to schedule and cutoff rules)
   - Add/Remove Menu Items (editable cart with pricing validation)
   - Change Quantity / Item Customizations
   - Cancel Order (automatic refund if within window)
   - Additional items: customer pays difference before confirming. Removed items: automatic partial refund.
   - **Limit**: Customers can only edit an order 2 times. Alert on 3rd attempt prompting them to contact restaurant.

3. **Restaurant Order Editing (High Priority)**:
   - Edit orders on behalf of customers via Active Orders tab.
   - Change Order Time, Add/Remove Items, Adjust Quantities.
   - Process Partial Refunds or Additional Charges via Stripe/Finix.
   - Add Internal Notes (visible only to staff/admins).
   - All restaurant-initiated edits trigger notification to customer.

4. **Approval Workflow (Optional)**: Restaurant can require approval before customer edits take effect. Customer submits request → Restaurant Approves/Rejects → Payment adjustments processed.

5. **Payment Handling**:
   - Additions: new charge processed immediately after customer confirmation.
   - Removals: automatic refund to original payment source.
   - Cancellations: full refund if within configured window.

6. **Activity Logging**: Every edit logged with Edit ID, Editor Role, Fields Changed, Timestamp, IP Address. Visible in Order Details History.

7. **Restrictions**: Orders in "Ready," "Out for Delivery," or "Completed" status cannot be edited. Conflicting simultaneous edits prevented.

---

### 3.6 Subscriptions and Reordering — **Medium Priority (On Hold — needs Order Editing first)**

#### Overview
Recurring order functionality: customers schedule recurring deliveries (weekly meal plans, monthly catering); restaurants view upcoming subscription schedules, apply loyalty incentives, manage volume predictability.

#### Role Access
| Role | Capabilities |
|------|-------------|
| Customer | Create subscriptions, modify frequency, pause or cancel |
| Restaurant Admin | View recurring orders, manage fulfillment, set promotions/discounts |
| System Admin / Regional Admin | Monitor subscription analytics, manage configurations |

#### Features

1. **Subscription Setup (Customer Portal)**:
   - Available on Order Confirmation screen and Order History via "Repeat this Order" / "Set Subscription."
   - Parameters: Frequency (Weekly/Bi-Weekly/Monthly/Custom), Start Date, End Condition (fixed date/count/until cancelled), Delivery or Pickup preference, Payment Method (saved credentials).

2. **Calendar View**:
   - **Customer**: Upcoming scheduled orders; click to view/modify items, quantities, delivery. Pause, skip, or cancel individual occurrence.
   - **Restaurant**: All orders listed in existing order management module. Calendar view for monthly view. Color-coded by status (Upcoming, In Progress, Completed, Paused). Symbol/color for Catering, Subscription, and Custom menu types. Filters by date range, customer, frequency type.

3. **Payment Processing**:
   - Auto-billing on scheduled order date.
   - Failed payment: email notification → retry mechanism (configurable, up to 3 attempts in 24hr intervals) → order placed on "Pause."
   - Customer resumes by taking payment action.
   - After 6 months in Pause state: automatically cancelled, no resume option.

4. **Restaurant Promotions and Loyalty Discounts**:
   - Configured in Restaurant Settings > Promotional Discount System.
   - Example: "10% off after 4 orders in a month" or "Free delivery on every 5th order."
   - Applied automatically at checkout when eligibility criteria are met.

5. **Notifications**: Subscription Created, Upcoming Order Reminder (24hr before; restaurants can configure lead time), Payment Confirmation, Failed Payment Alert, Subscription Modified/Canceled.

6. **Reporting Metrics**: Total Active Subscriptions, Renewal Rate, Subscription Order Revenue, Average Subscription Duration, Churn Rate, Promotional Discount Usage.

7. **System Rules**:
   - Subscriptions only for active menus.
   - Menu price/item changes auto-update next cycle with prior customer notification.
   - If restaurant disables online ordering, subscriptions auto-paused.
   - No overlapping subscriptions for same restaurant and date.

---

## FM API Endpoints Reference (confirmed from Angular source)

| Purpose | Method | Endpoint |
|---------|--------|----------|
| Restaurant orders (ADMIN) | GET | `/api/orders` |
| Restaurant orders (SYSTEM_ADMIN) | GET | `/api/system-admin/orders` |
| Restaurant profile / businessName | GET | `/api/restaurants` |
| User profile (name, email) | GET | `/api/users` |
| Sale statistics | GET | `/api/orders/saleStats` |
| Order statistics (unseen count) | GET | `/api/orders/{reference}/statistics` |
| Update order status | PUT | `/api/orders/{ref}/updateStatus?orderStatus={status}` |
| Mark order seen by admin | PUT | `/api/orders/{ref}/seenByAdmin` |
| Add note to order | PUT | `/api/orders/{ref}/note` |
| Admin user orders (SUPER_ADMIN) | GET | `/api/admin/userOrders` |
