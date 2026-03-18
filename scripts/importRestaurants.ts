// Run from your Sanity project folder:
//   npx ts-node --skip-project scripts/importRestaurants.ts
//
// Or from your Next.js project root:
//   npx ts-node --skip-project scripts/importRestaurants.ts

import { createClient } from '@sanity/client'

const client = createClient({
  projectId: '0j4eqnmw',
  dataset: 'production',
  token: process.env.SANITY_TOKEN, // set this in your .env.local
  apiVersion: '2024-01-01',
  useCdn: false,
})

const restaurants = [
  {name:"Chef Jordan Bailey",location:"Boston, MA",lat:42.3542,lng:-71.05187,cat:"https://www.familymeal.com/explore",cuisine:"Chef's Table",img:null,desc:"Chef Jordan Bailey is a partner restaurant based in Boston, MA.",isDisco:true},
  {name:"Hearthly Burger",location:"Shrewsbury, NJ",lat:40.2817,lng:-74.05617,cat:"https://www.familymeal.com/explore",cuisine:"Burgers",img:null,desc:"Hearthly Burger is a partner restaurant based in Shrewsbury, NJ.",isDisco:true},
  {name:"Marcel Bakery and Kitchen",location:"Montclair, NJ",lat:40.82,lng:-74.20197,cat:"https://www.familymeal.com/explore",cuisine:"Bakery",img:null,desc:"Marcel Bakery and Kitchen is a partner restaurant based in Montclair, NJ.",isDisco:true},
  {name:"Almost Home",location:"Lincroft, NJ",lat:40.3195,lng:-74.11587,cat:"https://www.familymeal.com/explore",cuisine:"American",img:null,desc:"Almost Home is a partner restaurant based in Lincroft, NJ.",isDisco:true},
  {name:"Firenze: Italian Street Food",location:"Chicago, IL",lat:41.8722,lng:-87.62277,cat:"https://www.familymeal.com/explore",cuisine:"Italian",img:null,desc:"Firenze: Italian Street Food is a partner restaurant based in Chicago, IL.",isDisco:true},
  {name:"The Speakeatery",location:"Asbury Park, NJ",lat:40.2145,lng:-74.00507,cat:"https://www.familymeal.com/explore",cuisine:"American",img:null,desc:"The Speakeatery is a partner restaurant based in Asbury Park, NJ.",isDisco:true},
  {name:"2nd Jetty Seafood",location:"Sea Bright, NJ",lat:40.352,lng:-73.96667,cat:"https://www.familymeal.com/explore",cuisine:"Seafood",img:null,desc:"2nd Jetty Seafood is a partner restaurant based in Sea Bright, NJ.",isDisco:true},
  {name:"Benchmark Breads",location:"Atlantic Highlands, NJ",lat:40.4034,lng:-74.02507,cat:"https://www.familymeal.com/explore",cuisine:"Bakery",img:null,desc:"Benchmark Breads is a partner restaurant based in Atlantic Highlands, NJ.",isDisco:false},
  {name:"Julio's Pizza Co.",location:"Atlantic Highlands, NJ",lat:40.41029,lng:-74.04675,cat:"https://www.familymeal.com/explore",cuisine:"Pizza",img:null,desc:"Julio's Pizza Co. is a partner restaurant based in Atlantic Highlands, NJ.",isDisco:false},
  {name:"Krewe de Fromage",location:"New York, NY",lat:40.7069,lng:-73.99897,cat:"https://www.familymeal.com/explore",cuisine:"French",img:null,desc:"Krewe de Fromage is a partner restaurant based in Manhattan, NY.",isDisco:false},
  {name:"Sandy Hook Seafood",location:"Sea Bright, NJ",lat:40.35889,lng:-73.98835,cat:"https://www.familymeal.com/explore",cuisine:"Seafood",img:null,desc:"Sandy Hook Seafood is a partner restaurant based in Sea Bright, NJ.",isDisco:true},
  {name:"Point Lobster",location:"Point Pleasant Beach, NJ",lat:40.0828,lng:-74.04087,cat:"https://www.familymeal.com/explore",cuisine:"Seafood",img:null,desc:"Point Lobster is a partner restaurant based in Point Pleasant Beach, NJ.",isDisco:false},
  {name:"Dinner Parties Do Good",location:"Chicago, IL",lat:41.87909,lng:-87.64445,cat:"https://www.familymeal.com/explore",cuisine:"American",img:null,desc:"Dinner Parties Do Good is a partner restaurant based in Chicago, IL.",isDisco:false},
  {name:"Local Smoke BBQ",location:"Red Bank, NJ",lat:40.3409,lng:-74.06757,cat:"https://www.familymeal.com/explore",cuisine:"BBQ",img:null,desc:"Local Smoke BBQ is a partner restaurant based in Red Bank, NJ.",isDisco:true},
  {name:"502 Baking Company",location:"Brick, NJ",lat:40.0472,lng:-74.10257,cat:"https://www.familymeal.com/explore",cuisine:"Bakery",img:null,desc:"502 Baking Company is a partner restaurant based in Brick, NJ.",isDisco:false},
  {name:"Francesca Pizza",location:"Bergen, NJ",lat:40.9228,lng:-74.02497,cat:"https://www.familymeal.com/explore",cuisine:"Pizza",img:null,desc:"Francesca Pizza is a partner restaurant based in Bergen, NJ.",isDisco:true},
  {name:"Keep It Sweet Desserts",location:"Tenafly, NJ",lat:40.9159,lng:-73.95197,cat:"https://www.familymeal.com/explore",cuisine:"Desserts",img:null,desc:"Keep It Sweet Desserts is a partner restaurant based in Tenafly, NJ.",isDisco:false},
  {name:"White Maple Cafe",location:"Ridgewood, NJ",lat:40.9734,lng:-74.10977,cat:"https://www.familymeal.com/explore",cuisine:"Cafe",img:null,desc:"White Maple Cafe is a partner restaurant based in Ridgewood, NJ.",isDisco:false},
  {name:"Wax Paper Co",location:"Los Angeles, CA",lat:34.0463,lng:-118.23667,cat:"https://www.familymeal.com/explore",cuisine:"Sandwiches",img:null,desc:"Wax Paper Co is a partner restaurant based in Los Angeles, CA.",isDisco:true},
  {name:"Black Bear BBQ",location:"Asheville, NC",lat:35.5892,lng:-82.54447,cat:"https://www.familymeal.com/explore",cuisine:"BBQ",img:null,desc:"Black Bear BBQ is a partner restaurant based in Asheville, NC.",isDisco:false},
  {name:"Bird & Co.",location:"Portland, ME",lat:43.6532,lng:-70.24977,cat:"https://www.familymeal.com/explore",cuisine:"American",img:null,desc:"Bird & Co. is a partner restaurant based in Portland, ME.",isDisco:true},
  {name:"Best Pizza",location:"New York, NY",lat:40.7156,lng:-73.9535,cat:"https://familymeal.com/disco/bestpizzawilliamsburg",cuisine:"Pizza",img:"https://images.squarespace-cdn.com/content/v1/66b4e6b122f497787aca9a8d/9fca7de0-79cb-4e29-8dd0-f51fb6d30f4a/Best+Pizza.png",desc:"Best Pizza is a beloved Williamsburg neighborhood slice joint from Frank Pinello. Famous for perfectly charred, thin-crust pies made with the freshest ingredients.",isDisco:true},
  {name:"Gertie",location:"Brooklyn, NY",lat:40.6764,lng:-73.968,cat:"https://familymeal.com/disco/gertie",cuisine:"Jewish Deli",img:"https://images.squarespace-cdn.com/content/v1/66b4e6b122f497787aca9a8d/2e5ddfa1-9649-4601-9f35-bce6c5d8be38/Gertie.png",desc:"A modern Jew-ish appetizing shop in Prospect Heights known for house-made bagels, smoked fish, dips, and Jewish comfort food with a contemporary Brooklyn sensibility.",isDisco:true},
  {name:"Lunetta",location:"Santa Monica, CA",lat:34.0136,lng:-118.48417,cat:"https://www.familymeal.com/explore",cuisine:"Italian",img:null,desc:"Lunetta is a partner restaurant based in Santa Monica, CA.",isDisco:true},
  {name:"Chicas Tacos",location:"Los Angeles, CA",lat:34.05319,lng:-118.25835,cat:"https://www.familymeal.com/explore",cuisine:"Mexican",img:null,desc:"Chicas Tacos is a partner restaurant based in Los Angeles, CA.",isDisco:false},
  {name:"Doce Donut Co.",location:"Seattle, WA",lat:47.6003,lng:-122.32507,cat:"https://www.familymeal.com/explore",cuisine:"Donuts",img:null,desc:"Doce Donut Co. is a partner restaurant based in Seattle, WA.",isDisco:true},
  {name:"Zutto",location:"New York, NY",lat:40.72124,lng:-73.99171,cat:"https://www.familymeal.com/explore",cuisine:"Japanese",img:null,desc:"Zutto is a partner restaurant based in Manhattan, NY.",isDisco:false},
  {name:"Uncle Paulie's Deli",location:"Los Angeles, CA",lat:34.06064,lng:-118.22941,cat:"https://www.familymeal.com/explore",cuisine:"Deli",img:null,desc:"Uncle Paulie's Deli is a partner restaurant based in Los Angeles, CA.",isDisco:true},
  {name:"Sweet Chick",location:"Brooklyn, NY",lat:40.7217,lng:-73.9873,cat:"https://familymeal.com/disco/sweetchick",cuisine:"Chicken & Waffles",img:"https://images.squarespace-cdn.com/content/v1/66b4e6b122f497787aca9a8d/9c16cebe-e585-48ee-934f-f618b160f9de/Sweet+Chick.png",desc:"A New York staple co-founded by John Seymour and rapper Nas, serving legendary chicken and waffles alongside Southern comfort food classics.",isDisco:true},
  {name:"Rangoon",location:"New York, NY",lat:40.742,lng:-74.0006,cat:"https://familymeal.com/disco/rangoonchelsea",cuisine:"Burmese",img:"https://images.squarespace-cdn.com/content/v1/66b4e6b122f497787aca9a8d/bb1ecfc2-d19b-41e6-ac2d-35d80b2433b7/Rangoon.png",desc:"Chelsea's standout Burmese restaurant from Chef Myo, offering authentic comfort dishes like the iconic tea leaf salad, garlic noodles, squash tempura, and bold skewers.",isDisco:true},
  {name:"Little Fatty",location:"Los Angeles, CA",lat:34.03644,lng:-118.24731,cat:"https://www.familymeal.com/explore",cuisine:"American",img:null,desc:"Little Fatty is a partner restaurant based in Los Angeles, CA.",isDisco:true},
  {name:"Black Seed Bagels",location:"New York, NY",lat:40.6878,lng:-73.9837,cat:"https://familymeal.com/disco/blackseedbagels",cuisine:"Bagels",img:"https://images.squarespace-cdn.com/content/v1/66b4e6b122f497787aca9a8d/ffbda65d-ff80-4737-a661-9091e33a5ca4/Black+Seed+Bagels-Marketplace.png",desc:"Steeped in old-world tradition, Black Seed Bagels is an artisan bagel shop led by James Beard-nominated executive chef Dianna Daoheung.",isDisco:true},
  {name:"Zara Mediterranean Charcoal Grill",location:"Glen Allen, VA",lat:37.6553,lng:-77.48097,cat:"https://www.familymeal.com/explore",cuisine:"Mediterranean",img:null,desc:"Zara Mediterranean Charcoal Grill is a partner restaurant based in Glen Allen, VA.",isDisco:false},
  {name:"Alta Calidad",location:"Brooklyn, NY",lat:40.6801,lng:-73.9682,cat:"https://familymeal.com/disco/altacalidad",cuisine:"Mexican",img:"https://images.squarespace-cdn.com/content/v1/66b4e6b122f497787aca9a8d/54a3d205-51fe-4907-adb2-d62bc8843874/Alta+Calidad-Marketplace.png",desc:"Alta Calidad — Spanish for 'high quality' — is an innovative Mexican restaurant in Prospect Heights helmed by Michelin Bib Gourmand award-winning chef Akhtar Nawab.",isDisco:true},
  {name:"Little Egg",location:"Brooklyn, NY",lat:40.6777,lng:-73.9635,cat:"https://familymeal.com/disco/littleegg",cuisine:"Breakfast",img:"https://images.squarespace-cdn.com/content/v1/66b4e6b122f497787aca9a8d/806098ad-91d5-452d-bbba-e9b676c1b0a3/Little+Egg.png",desc:"A bright, inviting breakfast and lunch spot with thoughtful, house-made dishes. Known for signature seasoned hash browns and perfectly cooked egg dishes.",isDisco:true},
  {name:"Mission Sandwich Social",location:"Brooklyn, NY",lat:40.7132,lng:-73.9624,cat:"https://familymeal.com/disco/missionsandwichsocial",cuisine:"Sandwiches",img:"https://images.squarespace-cdn.com/content/v1/66b4e6b122f497787aca9a8d/43962201-e6bf-4abf-908f-26c76db06e9a/Mission+Sandwich.png",desc:"Inspired by a love of sandwiches, baking, fine cuisine, and heavy metal, Mission Sandwich Social brings together many passions.",isDisco:true},
  {name:"Purslane",location:"Brooklyn, NY",lat:40.6823,lng:-73.9864,cat:"https://familymeal.com/disco/purslane",cuisine:"New American",img:"https://images.squarespace-cdn.com/content/v1/66b4e6b122f497787aca9a8d/8ddba7e1-34d9-4d24-ae75-5d6f418ebb46/Purslane-Marketplace.png",desc:"A Brooklyn-based catering company celebrated for fresh, seasonal ingredients and beautifully executed menus.",isDisco:true},
  {name:"Mekelburg's",location:"Brooklyn, NY",lat:40.7137,lng:-73.967,cat:"https://familymeal.com/disco/mekelburgs",cuisine:"American",img:"https://images.squarespace-cdn.com/content/v1/66b4e6b122f497787aca9a8d/72fbf8fb-88c9-48a1-9813-84baa4c0951e/Mekelburg%27s.png",desc:"A unique Williamsburg institution tucked behind a deli, offering elevated diner classics, craft beer, and warm hospitality.",isDisco:true},
  {name:"Springbone Kitchen",location:"New York, NY",lat:40.7587,lng:-73.9752,cat:"https://familymeal.com/disco/springbonekitchen",cuisine:"Healthy",img:"https://images.squarespace-cdn.com/content/v1/66b4e6b122f497787aca9a8d/a1f1f6f8-0b04-46e8-adae-53d759ad9b8c/Springbone+Kitchen.png",desc:"A health-focused fast-casual restaurant offering nourishing bowls built on bone broth rice, seasonal vegetables, and quality proteins.",isDisco:true},
  {name:"Pecking House",location:"Brooklyn, NY",lat:40.7133,lng:-73.9935,cat:"https://familymeal.com/disco/peckinghouse",cuisine:"Fried Chicken",img:"https://images.squarespace-cdn.com/content/v1/66b4e6b122f497787aca9a8d/cc5129a2-753e-4e2c-8d9c-6426078bf255/Pecking+House.png",desc:"A cult favorite known for exceptional chili oil fried chicken. The signature chili sandwich features a perfectly crispy, juicy thigh on soft milk bread.",isDisco:true},
  {name:"Utopia Bagels",location:"Queens, NY",lat:40.774,lng:-73.7879,cat:"https://familymeal.com/disco/utopiabagels",cuisine:"Bagels",img:"https://images.squarespace-cdn.com/content/v1/66b4e6b122f497787aca9a8d/bf4b625c-edf0-45fd-8c5a-e7c8080c1b3c/Utopia+Bagels.png",desc:"A Queens institution since 1981, Utopia Bagels hand-rolls and kettle-boils every bagel fresh daily.",isDisco:true},
  {name:"Veselka",location:"New York, NY",lat:40.729,lng:-73.9871,cat:"https://familymeal.com/disco/veselka",cuisine:"Ukrainian",img:"https://images.squarespace-cdn.com/content/v1/66b4e6b122f497787aca9a8d/ffbd5a00-b4d8-44b4-9ecd-2755b485b27b/Veselka.png",desc:"Since 1954, Veselka has been serving traditional Ukrainian comfort food from the same East Village location.",isDisco:true},
  {name:"See No Evil Pizza",location:"New York, NY",lat:40.7615,lng:-73.9845,cat:"https://familymeal.com/disco/seenoevilpizza",cuisine:"Pizza",img:"https://images.squarespace-cdn.com/content/v1/66b4e6b122f497787aca9a8d/fce69c9e-c983-43ff-919d-31fa6ba8e1f1/See+No+Evil+Pizza-Marketplace.png",desc:"A New York gem serving iconic thin-crust pizzas in a subway station with an 80s punk vibe.",isDisco:true},
  {name:"Namkeen",location:"Brooklyn, NY",lat:40.7129,lng:-73.9625,cat:"https://familymeal.com/disco/namkeenbrooklyn",cuisine:"Indian Fusion",img:"https://images.squarespace-cdn.com/content/v1/66b4e6b122f497787aca9a8d/0acec02c-21a2-4c4d-93b9-04b04cdca0fd/Namkeen-Marketplace.png",desc:"Namkeen brings bold South Asian spice and flavor to the fried chicken sandwich format, with halal-certified Nashville-style chicken.",isDisco:true},
  {name:"La Sandwicherie",location:"Brooklyn, NY",lat:40.7232,lng:-73.9447,cat:"https://familymeal.com/disco/lasandwicherie",cuisine:"French",img:"https://images.squarespace-cdn.com/content/v1/66b4e6b122f497787aca9a8d/a0d204ec-e058-42b9-b9a0-09269c5b828f/La+Sandwicherie-Marketplace.png",desc:"La Sandwicherie brings authentic French baguette sandwiches to New York, with ingredients sourced directly from France.",isDisco:true},
  {name:"Aunts et Uncles",location:"Brooklyn, NY",lat:40.6521,lng:-73.9495,cat:"https://familymeal.com/disco/auntsetuncles",cuisine:"Vegan",img:"https://images.squarespace-cdn.com/content/v1/66b4e6b122f497787aca9a8d/19652b15-16f9-4f16-a5bf-582ed66db09a/Aunts+et+Uncles-Marketplace.png",desc:"A lifestyle shop and plant-based café founded by Mike and Nicole Nicholas. Known for Caribbean-inspired flavors.",isDisco:true},
  {name:"Teranga",location:"New York, NY",lat:40.7584,lng:-73.9698,cat:"https://familymeal.com/disco/teranga",cuisine:"West African",img:"https://images.squarespace-cdn.com/content/v1/66b4e6b122f497787aca9a8d/379ebf24-c179-4598-b088-b8bd5195b343/Teranga_Marketplace.png",desc:"At Teranga, we are in constant conversation with tradition. Committed to serving authentic dishes from across Africa.",isDisco:true},
  {name:"Miss Ada",location:"Brooklyn, NY",lat:40.6894,lng:-73.9724,cat:"https://familymeal.com/disco/missada",cuisine:"Mediterranean",img:"https://images.squarespace-cdn.com/content/v1/66b4e6b122f497787aca9a8d/67adbf18-5a8e-4702-93a3-fd2432223687/MissAda-Marketplace.png",desc:"An inviting neighborhood restaurant in Fort Greene led by Israeli-born Chef Tomer Blechman, creating a unique twist on modern Mediterranean cuisine.",isDisco:true},
  {name:"Fish Cheeks",location:"New York, NY",lat:40.7258,lng:-73.9926,cat:"https://familymeal.com/disco/fishcheeks",cuisine:"Thai",img:"https://images.squarespace-cdn.com/content/v1/66b4e6b122f497787aca9a8d/a8994528-9835-4ed4-8972-6da264366bf7/Fish+Cheeks-Marketplace.png",desc:"A vibrant restaurant on Bond Street in NoHo serving contemporary Thai food with a focus on seafood.",isDisco:true},
  {name:"Thea Bakery",location:"Brooklyn, NY",lat:40.6861,lng:-73.9727,cat:"https://familymeal.com/disco/thea",cuisine:"Bakery",img:"https://images.squarespace-cdn.com/content/v1/66b4e6b122f497787aca9a8d/596a9344-0726-4c25-a14c-03d572fb82ee/Thea-Marketplace.png",desc:"From the team behind Miss Ada, Thea serves house-made bourekas, babkas, pastries, breads, and sandwiches.",isDisco:true},
  {name:"Motorino",location:"New York, NY",lat:40.7304,lng:-73.9838,cat:"https://familymeal.com/disco/motorino",cuisine:"Pizza",img:"https://images.squarespace-cdn.com/content/v1/66b4e6b122f497787aca9a8d/a714d3f6-0771-49a5-b8a3-19c4b9d6c4ef/Motorino-Marketplace.png",desc:"An acclaimed wood-fired Neapolitan pizzeria in the East Village, celebrated for perfectly blistered pies.",isDisco:true},
  {name:"COPS",location:"New York, NY",lat:40.7335,lng:-74.0027,cat:"https://familymeal.com/disco/cops",cuisine:"American",img:"https://images.squarespace-cdn.com/content/v1/66b4e6b122f497787aca9a8d/3c798d42-bc9a-4cdf-9acc-1adec2ed4dd8/COPS-Marketplace.png",desc:"COPS is a West Village neighborhood spot serving approachable American fare with a creative, market-driven sensibility.",isDisco:true},
  {name:"Strange Delight",location:"Brooklyn, NY",lat:40.6874,lng:-73.976,cat:"https://familymeal.com/disco/strangedelight",cuisine:"Seafood",img:"https://images.squarespace-cdn.com/content/v1/66b4e6b122f497787aca9a8d/814502c7-82b0-42fb-b2b6-6eccfff24601/StrangeDelight-Marketplace.png",desc:"A Fort Greene seafood restaurant offering a rotating seafood tower, chargrilled oysters, and exceptional fried chicken.",isDisco:true},
  {name:"Brown Bag Sandwich Co.",location:"New York, NY",lat:40.729,lng:-73.9991,cat:"https://familymeal.com/disco/brownbagsandwichco",cuisine:"Sandwiches",img:"https://images.squarespace-cdn.com/content/v1/66b4e6b122f497787aca9a8d/abcdc47d-9142-4075-b3bf-989e10207867/Brown+Bag+Sandwich+Co-Marketplace.png",desc:"An old-school Greenwich Village sandwich shop serving exceptional sandwiches on world-class bread.",isDisco:true},
  {name:"Mile End Deli",location:"Brooklyn, NY",lat:40.6874,lng:-73.987,cat:"https://familymeal.com/disco/mileenddeli",cuisine:"Deli",img:"https://images.squarespace-cdn.com/content/v1/66b4e6b122f497787aca9a8d/26031ae2-4336-4b27-a198-c2523338698f/Mile+End+Delicatessen-Marketplace.png",desc:"Brooklyn's beloved Montreal-style Jewish deli, known for its exceptional smoked meat sandwich.",isDisco:true},
  {name:"Decades Pizza",location:"Queens, NY",lat:40.7049,lng:-73.9058,cat:"https://familymeal.com/disco/decadespizza",cuisine:"Pizza",img:"https://images.squarespace-cdn.com/content/v1/66b4e6b122f497787aca9a8d/03a34b75-5b7a-4d4d-90e7-73f898f40dbd/Decades+Pizza.png",desc:"The loveable neo-classical Decades Pizza in Ridgewood, Queens, from two self-professed pizza obsessives.",isDisco:true},
  {name:"Brooklyn Dumpling Shop",location:"Brooklyn, NY",lat:40.7709,lng:-73.9511,cat:"https://familymeal.com/disco/brooklyndumplingshop",cuisine:"Dumplings",img:"https://images.squarespace-cdn.com/content/v1/66b4e6b122f497787aca9a8d/dc366837-6cc2-41c5-ad60-4062b3d99a0a/BROOKLYN+DUMPLING+SHOP.png",desc:"A tech-forward dumpling concept blending classic New York diner flavors with modern automation.",isDisco:true},
  {name:"Rokstar Chicken",location:"Queens, NY",lat:40.755,lng:-73.7378,cat:"https://familymeal.com/disco/rokstarchicken",cuisine:"Chicken",img:"https://images.squarespace-cdn.com/content/v1/66b4e6b122f497787aca9a8d/d7ce149d-f5b6-4572-922e-6a69fdd72387/ROKSTAR+CHICKEN.png",desc:"A Korean fried chicken concept serving perfectly crispy wings and sandwiches with bold sauces.",isDisco:true},
  {name:"Son del North",location:"New York, NY",lat:40.7218,lng:-73.9885,cat:"https://familymeal.com/disco/sondelnorth",cuisine:"Mexican",img:"https://images.squarespace-cdn.com/content/v1/66b4e6b122f497787aca9a8d/85831242-db5f-4c42-a51d-e6ef4c4fab86/Son+del+North.png",desc:"Specializes in Sonoran-style burritos — packed with grilled meats, fresh salsas, and no rice.",isDisco:true},
  {name:"Wexler's Deli",location:"Santa Monica, CA",lat:34.02049,lng:-118.50585,cat:"https://www.familymeal.com/explore",cuisine:"Deli",img:null,desc:"Wexler's Deli is a partner restaurant based in Santa Monica, CA.",isDisco:true},
  {name:"Pine & Crane",location:"Los Angeles, CA",lat:34.03503,lng:-118.21182,cat:"https://www.familymeal.com/explore",cuisine:"Taiwanese",img:null,desc:"Pine & Crane is a partner restaurant based in Los Angeles, CA.",isDisco:true},
  {name:"De Nada Cantina",location:"Austin, TX",lat:30.25144,lng:-97.74671,cat:"https://www.familymeal.com/explore",cuisine:"Mexican",img:null,desc:"De Nada Cantina is a partner restaurant based in Austin, TX.",isDisco:true},
  {name:"Lil' Easy",location:"Austin, TX",lat:30.26213,lng:-97.71849,cat:"https://www.familymeal.com/explore",cuisine:"Southern",img:null,desc:"Lil' Easy is a partner restaurant based in Austin, TX.",isDisco:true},
  {name:"Pete's Bagels",location:"Tampa, FL",lat:27.95159,lng:-82.47185,cat:"https://www.familymeal.com/explore",cuisine:"Bagels",img:null,desc:"Pete's Bagels is a partner restaurant based in Tampa, FL.",isDisco:true},
  {name:"Willa's",location:"Tampa, FL",lat:27.9447,lng:-82.45017,cat:"https://www.familymeal.com/explore",cuisine:"American",img:null,desc:"Willa's is a partner restaurant based in Tampa, FL.",isDisco:true},
  {name:"Hatch 44",location:"Bradley Beach, NJ",lat:40.197,lng:-74.00257,cat:"https://www.familymeal.com/explore",cuisine:"American",img:null,desc:"Hatch 44 is a partner restaurant based in Bradley Beach, NJ.",isDisco:true},
  {name:"Pie Girl",location:"Hightstown, NJ",lat:40.2634,lng:-74.51927,cat:"https://www.familymeal.com/explore",cuisine:"Bakery",img:null,desc:"Pie Girl is a partner restaurant based in Hightstown, NJ.",isDisco:true},
  {name:"Colonial Ranch Market",location:"Point Pleasant, NJ",lat:40.0767,lng:-74.06477,cat:"https://www.familymeal.com/explore",cuisine:"American",img:null,desc:"Colonial Ranch Market is a partner restaurant based in Point Pleasant, NJ.",isDisco:true},
  {name:"Good&Fantzye",location:"Kingston, NY",lat:41.92879,lng:-74.01395,cat:"https://www.familymeal.com/explore",cuisine:"Jewish Deli",img:null,desc:"Good&Fantzye is a partner restaurant based in Kingston, NY.",isDisco:true},
  {name:"Smogen Appetizers",location:"Los Angeles, CA",lat:34.06289,lng:-118.27351,cat:"https://www.familymeal.com/explore",cuisine:"Scandinavian",img:null,desc:"Smogen Appetizers is a partner restaurant based in Los Angeles, CA.",isDisco:true},
  {name:"29 Hance Bakehouse",location:"Fair Haven, NJ",lat:40.3578,lng:-74.02867,cat:"https://www.familymeal.com/explore",cuisine:"Bakery",img:null,desc:"29 Hance Bakehouse is a partner restaurant based in Fair Haven, NJ.",isDisco:true},
  {name:"Maciel's Plant-Based Butcher Shop",location:"Highland Park, CA",lat:34.1057,lng:-118.17777,cat:"https://www.familymeal.com/explore",cuisine:"Vegan",img:null,desc:"Maciel's Plant-Based Butcher Shop is a partner restaurant based in Highland Park, CA.",isDisco:true},
  {name:"Major Food Group",location:"New York, NY",lat:40.7589,lng:-73.9851,cat:"https://familymeal.com/disco/majorfoodgroup",cuisine:"Italian",img:null,desc:"Major Food Group is the hospitality company behind Carbone, Sadelle's, and more.",isDisco:true},
  {name:"Vesti",location:"Los Angeles, CA",lat:34.08036,lng:-118.25182,cat:"https://www.familymeal.com/explore",cuisine:"Italian",img:null,desc:"Vesti is a partner restaurant based in Los Angeles, CA.",isDisco:true},
  {name:"Animo!",location:"New York, NY",lat:40.7576,lng:-73.9642,cat:"https://familymeal.com/disco/animo",cuisine:"Mexican",img:null,desc:"Ánimo! brings scratch-made, authentic Mexican cuisine to Midtown East.",isDisco:true},
  {name:"gtk",location:"New York, NY",lat:40.7282,lng:-73.9942,cat:"https://familymeal.com/disco/gtk",cuisine:"American",img:null,desc:"gtk is an all-day neighborhood concept across Manhattan known for fresh, seasonal cooking.",isDisco:true},
]

async function importRestaurants() {
  console.log(`Importing ${restaurants.length} restaurants...`)
  let created = 0, skipped = 0

  for (const r of restaurants) {
    try {
      // Check if exists
      const existing = await client.fetch(`*[_type == "restaurant" && name == $name][0]._id`, { name: r.name })
      if (existing) { skipped++; continue }

      await client.create({
        _type: 'restaurant',
        name: r.name,
        slug: { _type: 'slug', current: r.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') },
        location: r.location,
        cuisine: r.cuisine,
        lat: r.lat,
        lng: r.lng,
        isDisco: r.isDisco,
        orderUrl: r.cat,
        description: r.desc,
        featured: r.isDisco && !!r.img,
      })
      created++
      console.log(`✓ ${r.name}`)
    } catch (e) {
      console.error(`✗ ${r.name}:`, e)
    }
  }

  console.log(`\nDone! Created: ${created}, Skipped (already exist): ${skipped}`)
}

importRestaurants()