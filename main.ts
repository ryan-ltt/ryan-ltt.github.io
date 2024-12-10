/*
function updateText(){

}
*/

/*
hw: no new features, refactor code & find opportunities to reduce duplication, simplify logic, fix squiggly errors 
investigate html/css further, make UI more interesting/elegant/user friendly. implement refresh button
implement instructions underneath a detail summary, like an accordion to show instructions
easier navigation of the website, back to home page
try it on mobile, look up how to manipulate meta-properties to make it installable (manifest property)

weeks ahead: further progress, multiplayer with other real humans
this would require server to save state, facilitate connections
try to do js server

reading list: the phoenix project
*/
// enum to track players
enum Player {
  X = "X",
  O = "O",
}
// initialize currentplayer to X to start game
let currentPlayer: Player = Player.X;

// link to where images are stored
const playerImages = {
  [Player.X]: "images/horse.jpg",
  [Player.O]: "images/rabbit.jpg",
} as const;

// structure to store button values
type GameStateValue = "" | "X" | "O";
type GameState = GameStateValue[];

let gameState: GameState = [];
for (let i = 0; i < 10; i++) {
  gameState[i] = "";
}

let turnCount: number = 0;
let hasWon: boolean = false;

// Select all buttons with the class 'item-button' and add click event listener to each button
const buttons = document.querySelectorAll<HTMLButtonElement>(".item-button");
buttons.forEach((button) => {
  button.addEventListener("click", () => handleClick(button));
});

const gameText = document.getElementById("gametext")!;
const refreshText = document.getElementById("refreshtext")!;

/**
 * Handle the click event on a button.
 * @param button The button that was clicked.
 */
function handleClick(button: HTMLButtonElement) {
  // Prevent overriding an already clicked button
  if (button.dataset.player || hasWon) {
    return;
  }
  // updating the button's value with the currentPlayer
  button.dataset.player = currentPlayer;

  const indexValue = Number(button.dataset.index) - 1;
  const player = button.dataset.player as Player;

  // Update game state

  gameState[indexValue] = player;
  console.log(button.dataset.player);
  turnCount++;

  // Then update UI
  updateButtonWithPlayer(button);

  // Check win conditions
  console.log(gameState);
  hasWon = checkWin(gameState);
  if (hasWon) {
    gameText.innerText =
      currentPlayer === Player.X ? "the horse wins!" : "the rabbit wins!";
    refreshText.innerText = "refresh to play again!";
    return;
  }

  // check for draw
  if (turnCount === 9 && !hasWon) {
    gameText.innerText = "draw!";
    refreshText.innerText = "refresh to play again!";
    return;
  }
  // otherwise keep playing
  currentPlayer = currentPlayer === Player.X ? Player.O : Player.X;
  gameText.innerText =
    currentPlayer === Player.X ? "horse's turn!" : "rabbit's turn!";
  refreshText.innerText = "";
}

function updateButtonWithPlayer(button) {
  // Insert the image corresponding to the current player
  const img = document.createElement("img");
  img.src = playerImages[currentPlayer];
  img.alt = currentPlayer;
  img.draggable = false; // Prevent dragging the image

  button.appendChild(img);
}

/**
 *
 * @param game
 * @returns
 */
function checkWin(game): boolean {
  // checking rows for 3 in a row
  for (let i = 0; i < game.length; i += 3) {
    if (game[i] !== "" && game[i] === game[i + 1] && game[i] === game[i + 2]) {
      return true;
    }
  }
  // checking columns for 3 in a row
  for (let i = 0; i < 3; i++) {
    if (game[i] !== "" && game[i] === game[i + 3] && game[i] === game[i + 6]) {
      return true;
    }
  }
  // checking diagonals manually, \ diag
  if (game[0] !== "" && game[0] === game[4] && game[0] === game[8]) {
    return true;
  }
  // checking / diag
  if (game[2] !== "" && game[2] === game[4] && game[2] === game[6]) {
    return true;
  }
  return false;
}
