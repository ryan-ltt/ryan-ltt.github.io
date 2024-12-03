// Select all buttons with the class 'item-button'
var buttons = document.querySelectorAll('.item-button');
// Add click event listener to each button
buttons.forEach(function (button) {
    button.addEventListener('click', function () {
        // Example action: Log the button's text content
        console.log("Button ".concat(button.textContent, " clicked"));
        // Example: Toggle between 'X' and 'O'
        if (button.textContent === 'X' || button.textContent === 'O') {
            // Do nothing or reset
            return;
        }
        button.textContent = 'X'; // Or implement game logic to alternate
    });
});
